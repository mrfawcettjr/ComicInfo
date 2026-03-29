/** Vercel-friendly upload size (must stay within serverless body limits). */
const MAX_BYTES = 1024 * 1024;
/** Prefer outputs in this band when the source has enough resolution. */
const TARGET_MIN_BYTES = Math.floor(0.8 * 1024 * 1024);
const ABS_MIN_EDGE = 640;
const ABS_MAX_EDGE = 4096;

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not encode image."));
        }
      },
      "image/jpeg",
      quality,
    );
  });
}

function drawBitmapToCanvas(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is not available.");
  }
  let width = bitmap.width;
  let height = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

/**
 * Best-effort JPEG under MAX_BYTES for the current canvas pixels.
 */
async function bestJpegUnderLimit(canvas: HTMLCanvasElement): Promise<Blob> {
  let low = 0.28;
  let high = 0.95;
  let best: Blob | null = null;

  for (let i = 0; i < 14; i++) {
    const mid = (low + high) / 2;
    const blob = await jpegBlob(canvas, mid);
    if (blob.size <= MAX_BYTES) {
      best = blob;
      low = mid;
    } else {
      high = mid;
    }
  }

  let candidate = await jpegBlob(canvas, low);
  if (candidate.size <= MAX_BYTES) {
    return candidate;
  }
  if (best && best.size <= MAX_BYTES) {
    return best;
  }

  for (let q = 0.26; q >= 0.18; q -= 0.02) {
    candidate = await jpegBlob(canvas, q);
    if (candidate.size <= MAX_BYTES) {
      return candidate;
    }
  }

  return jpegBlob(canvas, 0.18);
}

function toUploadFile(blob: Blob, originalName: string): File {
  const base = originalName.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
}

/**
 * Re-encode images client-side so uploads stay ≤ 1 MB for Vercel, targeting ~0.8–1.0 MB when possible.
 */
export async function compressImageForUpload(file: File): Promise<File> {
  if (file.size <= MAX_BYTES && file.size >= TARGET_MIN_BYTES && file.type === "image/jpeg") {
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "Could not read this image in the browser. Try JPEG or PNG, or a smaller file.",
    );
  }

  try {
    let maxEdge = 2560;

    while (maxEdge >= ABS_MIN_EDGE) {
      const canvas = drawBitmapToCanvas(bitmap, maxEdge);
      const blob = await bestJpegUnderLimit(canvas);

      if (blob.size > MAX_BYTES) {
        maxEdge = Math.floor(maxEdge * 0.85);
        continue;
      }

      if (blob.size >= TARGET_MIN_BYTES || maxEdge >= ABS_MAX_EDGE - 64) {
        return toUploadFile(blob, file.name);
      }

      const nextEdge = Math.min(ABS_MAX_EDGE, Math.round(maxEdge * 1.12));
      if (nextEdge <= maxEdge) {
        return toUploadFile(blob, file.name);
      }
      maxEdge = nextEdge;
    }

    throw new Error("Could not compress image under 1 MB. Try a smaller original photo.");
  } finally {
    bitmap.close();
  }
}

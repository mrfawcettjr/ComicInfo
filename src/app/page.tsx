"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ComicInfo } from "@/lib/comic-schema";

const MAX_IMAGES = 4;

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tif|tiff)$/.test(lower);
}

function prettyList(items: string[]) {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">None detected.</p>;
  }

  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

/** Prefer API `details` when present; combine with `error` when both differ (e.g. generic summary + Gemini message). */
function formatAnalyzeFailureMessage(
  body: { error?: string; details?: string },
  httpStatus: number,
): string {
  const summary = body.error?.trim();
  const details = body.details?.trim();

  if (details && summary && details !== summary) {
    return `${summary}\n\n${details}`;
  }
  if (details) {
    return details;
  }
  if (summary) {
    return summary;
  }
  return `Analysis failed (HTTP ${httpStatus}).`;
}

function preventDragDefaults(event: React.DragEvent) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ComicInfo | null>(null);
  const [rawJson, setRawJson] = useState<string>("");

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  function mergeFiles(incoming: File[]) {
    const imageFiles = incoming.filter((file) => isImageFile(file));
    if (imageFiles.length === 0) {
      setError("Please drop image files only.");
      return;
    }

    setFiles((previous) => {
      const merged = [...previous, ...imageFiles].slice(0, MAX_IMAGES);
      if (previous.length + imageFiles.length > MAX_IMAGES) {
        setError(`Only ${MAX_IMAGES} images are allowed. Extra files were ignored.`);
      } else {
        setError(null);
      }
      return merged;
    });
  }

  async function analyze() {
    if (files.length === 0) {
      setError("Please add at least one image.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setRawJson("");

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("images", file);
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(
          response.ok
            ? "The server returned a response that was not valid JSON."
            : `Request failed (${response.status}). The server response was not valid JSON.`,
        );
      }

      const body = payload as {
        data?: ComicInfo;
        error?: string;
        details?: string;
      };

      if (!response.ok || !body.data) {
        throw new Error(formatAnalyzeFailureMessage(body, response.status));
      }

      setResult(body.data);
      setRawJson(JSON.stringify(body.data, null, 2));
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : "Analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">ComicInfo</h1>
        <p className="text-zinc-600 dark:text-zinc-300">
          Drag up to 4 comic photos from Photos or Finder, then analyze for title, issue,
          publication date, characters, key events, and an approximate CGC-style grade from
          visible condition.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Google Lens is not available as a public API. This app uses{" "}
          <span className="font-medium">Google Gemini</span> multimodal vision for Lens-like
          image understanding. Photos are sent to Google for analysis. CGC estimates are
          unofficial and for reference only. Do not upload sensitive images.
        </p>
      </section>

      <section
        className="flex min-h-[220px] flex-col gap-4 rounded-xl border-2 border-dashed border-zinc-300 p-6 transition hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
        onDragEnter={preventDragDefaults}
        onDragOver={preventDragDefaults}
        onDrop={(event) => {
          event.preventDefault();
          mergeFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            Drop images anywhere in this box, or choose files. Supported: JPG, PNG, WEBP, HEIC.
          </p>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files ? Array.from(event.target.files) : [];
                mergeFiles(selected);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose files
            </button>
          </div>
        </div>

        {previews.length > 0 && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {previews.map((preview, index) => (
              <div
                key={`${preview.file.name}-${preview.file.size}-${index}`}
                className="space-y-2 rounded border p-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.url}
                  alt={preview.file.name}
                  className="h-32 w-full rounded object-cover"
                  draggable={false}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs">{preview.file.name}</p>
                  <button
                    type="button"
                    className="cursor-pointer rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
                    onClick={() => {
                      setFiles((previous) =>
                        previous.filter((_, itemIndex) => itemIndex !== index),
                      );
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={analyze}
          disabled={loading || files.length === 0}
          className="cursor-pointer rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
        {files.length > 0 && (
          <button
            type="button"
            className="cursor-pointer rounded border px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
            onClick={() => {
              setFiles([]);
              setResult(null);
              setRawJson("");
              setError(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 break-words whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          role="alert"
        >
          {error}
        </div>
      )}

      {result && (
        <section className="space-y-4 rounded-xl border p-4">
          <h2 className="text-xl font-semibold">Analysis Result</h2>
          <div className="grid gap-2 md:grid-cols-2">
            <p>
              <span className="font-medium">Title:</span> {result.title ?? "Unknown"}
            </p>
            <p>
              <span className="font-medium">Issue Number:</span>{" "}
              {result.issueNumber ?? "Unknown"}
            </p>
            <p>
              <span className="font-medium">Year:</span> {result.year ?? "Unknown"}
            </p>
            <p>
              <span className="font-medium">Month:</span> {result.month ?? "Unknown"}
            </p>
            <p className="md:col-span-2">
              <span className="font-medium">Approx. CGC grade (condition):</span>{" "}
              {result.approximateCgcGrade ?? "Unknown"}{" "}
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                (unofficial estimate from photos, not a certified grade)
              </span>
            </p>
          </div>
          <div>
            <h3 className="font-medium">Key Characters</h3>
            {prettyList(result.keyCharacters)}
          </div>
          <div>
            <h3 className="font-medium">Key Events</h3>
            {prettyList(result.keyEvents)}
          </div>
          <div>
            <h3 className="font-medium">Confidence Notes</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              {result.confidenceNotes ?? "No confidence notes provided."}
            </p>
          </div>
          <div>
            <h3 className="font-medium">Raw JSON</h3>
            <pre className="overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
              {rawJson}
            </pre>
          </div>
        </section>
      )}
    </main>
  );
}

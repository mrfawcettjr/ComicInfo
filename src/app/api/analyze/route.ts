import { GoogleGenerativeAI, SchemaType, type ObjectSchema } from "@google/generative-ai";
import sharp from "sharp";

import { comicInfoSchema } from "@/lib/comic-schema";
import { extractJsonFromModelOutput } from "@/lib/extract-model-json";

export const runtime = "nodejs";

const MAX_IMAGES = 4;
/** Keep uploads small enough for Vercel serverless request body limits (~4.5MB total). */
const MAX_FILE_BYTES = 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function geminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

function isSupportedMimeType(type: string) {
  return ACCEPTED_MIME_TYPES.has(type.toLowerCase());
}

function buildPrompt() {
  return [
    "You are performing Lens-style visual analysis on up to four comic book photos: read cover text, identify characters and scenes, and assess visible physical condition.",
    "Use only details visible in the images. Do not invent facts.",
    "Return a JSON object with exactly these fields:",
    "title (string or null), issueNumber (string or null), year (number or null), month (string or null),",
    "keyCharacters (string[]), keyEvents (string[]), approximateCgcGrade (string or null), confidenceNotes (string or null).",
    "For keyEvents, describe notable plot or cover moments visible in the images only.",
    "If data is not visible or uncertain, set it to null for scalar fields and [] for arrays.",
    "For month, use a full month name such as January, February, ... when available.",
    "approximateCgcGrade: estimate a CGC-like numeric grade on the 0.5-10.0 scale from visible wear only (corners, spine, creases, color breaks, tears, stains, missing chunks).",
    "Use a single number like 9.2 or a short range like 7.5-8.0 if uncertain. Set null if the book edges or condition cannot be judged from the photos.",
    "In confidenceNotes, briefly state limitations (e.g. glare, crop) and that this is not an official CGC grade.",
    "Keep keyCharacters and keyEvents concise.",
  ].join(" ");
}

const comicResponseSchema: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING, nullable: true },
    issueNumber: { type: SchemaType.STRING, nullable: true },
    year: { type: SchemaType.INTEGER, nullable: true },
    month: { type: SchemaType.STRING, nullable: true },
    keyCharacters: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    keyEvents: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    approximateCgcGrade: { type: SchemaType.STRING, nullable: true },
    confidenceNotes: { type: SchemaType.STRING, nullable: true },
  },
  required: [
    "title",
    "issueNumber",
    "year",
    "month",
    "keyCharacters",
    "keyEvents",
    "approximateCgcGrade",
    "confidenceNotes",
  ],
};

async function normalizeImage(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const originalBuffer = Buffer.from(arrayBuffer);

  try {
    const converted = await sharp(originalBuffer)
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    return {
      base64: converted.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch {
    const mimeType = file.type || "application/octet-stream";
    return {
      base64: originalBuffer.toString("base64"),
      mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg",
    };
  }
}

export async function POST(request: Request) {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    return Response.json(
      {
        error:
          "GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY).",
      },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();
    const imageEntries = formData.getAll("images");
    const files = imageEntries.filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      return Response.json(
        { error: "Upload at least one image to analyze." },
        { status: 400 },
      );
    }

    if (files.length > MAX_IMAGES) {
      return Response.json(
        { error: `You can upload up to ${MAX_IMAGES} images at once.` },
        { status: 400 },
      );
    }

    for (const file of files) {
      if (!isSupportedMimeType(file.type) && !file.type.startsWith("image/")) {
        return Response.json(
          { error: `Unsupported file type: ${file.name}` },
          { status: 400 },
        );
      }

      if (file.size > MAX_FILE_BYTES) {
        return Response.json(
          {
            error: `File is too large: ${file.name}. Max size is ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB per file (Vercel request limit).`,
          },
          { status: 400 },
        );
      }
    }

    const normalizedImages = await Promise.all(files.map((file) => normalizeImage(file)));

    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: comicResponseSchema,
      },
    });

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: buildPrompt() },
      ...normalizedImages.map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.base64,
        },
      })),
    ];

    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
    });

    const rawOutput = result.response.text()?.trim() ?? "";
    if (!rawOutput) {
      const block = result.response.promptFeedback?.blockReason;
      return Response.json(
        {
          error: "Empty model output.",
          details: block ? `Blocked: ${block}` : "No text returned from the model.",
        },
        { status: 502 },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonFromModelOutput(rawOutput));
    } catch (parseError) {
      return Response.json(
        {
          error: "Could not parse model JSON.",
          details: parseError instanceof Error ? parseError.message : String(parseError),
        },
        { status: 502 },
      );
    }

    const parsed = comicInfoSchema.parse(parsedJson);

    return Response.json({ data: parsed });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error during analysis.";
    return Response.json(
      { error: "Failed to analyze images.", details: message },
      { status: 500 },
    );
  }
}

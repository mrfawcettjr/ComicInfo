import { GoogleGenerativeAI, SchemaType, type ObjectSchema } from "@google/generative-ai";
import sharp from "sharp";

import { conditionAssessmentSchema } from "@/lib/comic-schema";
import { extractJsonFromModelOutput } from "@/lib/extract-model-json";

export const runtime = "nodejs";

const MAX_IMAGES = 4;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
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

function geminiModelName() {
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

function isSupportedMimeType(type: string) {
  return ACCEPTED_MIME_TYPES.has(type.toLowerCase());
}

function buildPrompt() {
  return [
    "You are grading comic condition from uploaded cover photos.",
    "Use only visible evidence from the provided images.",
    "Return JSON with exactly these fields:",
    'physicalCondition (string): short label such as "Good", "Very Good", "Fine", "Very Fine", "Near Mint". Use "" when unclear.',
    'conditionNotes (string): brief factual notes about visible wear/defects/positives (ticks, creases, tears, stains, gloss, corner wear, writing, restoration signs). Use "" when unsupported.',
    'cgcGradeRange (string): CGC-style numeric range as "x.x to y.y" with one decimal each (e.g. "7.0 to 8.0"). Use "" when uncertain.',
    "Do not invent slab verification, census counts, or grading certainty.",
  ].join(" ");
}

const responseSchema: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    physicalCondition: { type: SchemaType.STRING },
    conditionNotes: { type: SchemaType.STRING },
    cgcGradeRange: { type: SchemaType.STRING },
  },
  required: ["physicalCondition", "conditionNotes", "cgcGradeRange"],
};

async function normalizeImage(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const originalBuffer = Buffer.from(arrayBuffer);

  try {
    const converted = await sharp(originalBuffer)
      .rotate()
      .resize({
        width: 3072,
        height: 3072,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92, mozjpeg: true })
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
        { error: "Upload at least one image to re-grade." },
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
            error: `File is too large for high-res re-grade: ${file.name}. Max size is ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB per file.`,
          },
          { status: 400 },
        );
      }
    }

    const normalizedImages = await Promise.all(files.map((file) => normalizeImage(file)));
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: geminiModelName(),
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
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

    const parsedJson = JSON.parse(extractJsonFromModelOutput(rawOutput));
    const assessment = conditionAssessmentSchema.parse(parsedJson);

    return Response.json({ data: assessment });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error during re-grade.";
    return Response.json({ error: "Failed to re-grade images.", details: message }, { status: 500 });
  }
}


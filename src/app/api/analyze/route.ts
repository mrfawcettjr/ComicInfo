import OpenAI from "openai";
import sharp from "sharp";

import { comicInfoSchema } from "@/lib/comic-schema";
import { extractJsonFromModelOutput } from "@/lib/extract-model-json";

export const runtime = "nodejs";

const MAX_IMAGES = 4;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

function isSupportedMimeType(type: string) {
  return ACCEPTED_MIME_TYPES.has(type.toLowerCase());
}

function buildPrompt() {
  return [
    "You are extracting comic book metadata from up to four photos.",
    "Use only details visible in the images. Do not guess.",
    "Return a JSON object with exactly these fields:",
    "title (string or null), issueNumber (string or null), year (number or null), month (string or null), keyCharacters (string[]), keyEvents (string[]), confidenceNotes (string or null).",
    "If data is not visible or uncertain, set it to null for scalar fields and [] for arrays.",
    "For month, use a full month name such as January, February, ... when available.",
    "Keep keyCharacters and keyEvents concise and factual.",
  ].join(" ");
}

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
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
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
            error: `File is too large: ${file.name}. Max size is ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB.`,
          },
          { status: 400 },
        );
      }
    }

    const normalizedImages = await Promise.all(files.map((file) => normalizeImage(file)));

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL ?? "gpt-4.1";

    const content: Array<
      { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }
    > = [
      { type: "input_text", text: buildPrompt() },
      ...normalizedImages.map((image) => ({
        type: "input_image" as const,
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        detail: "auto" as const,
      })),
    ];

    const response = await client.responses.create({
      model,
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "comic_info",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: ["string", "null"] },
              issueNumber: { type: ["string", "null"] },
              year: { type: ["number", "null"] },
              month: { type: ["string", "null"] },
              keyCharacters: {
                type: "array",
                items: { type: "string" },
              },
              keyEvents: {
                type: "array",
                items: { type: "string" },
              },
              confidenceNotes: { type: ["string", "null"] },
            },
            required: [
              "title",
              "issueNumber",
              "year",
              "month",
              "keyCharacters",
              "keyEvents",
              "confidenceNotes",
            ],
          },
          strict: true,
        },
      },
    });

    if (response.error) {
      return Response.json(
        {
          error: "The model returned an error.",
          details: JSON.stringify(response.error),
        },
        { status: 502 },
      );
    }

    if (response.status && response.status !== "completed") {
      return Response.json(
        {
          error: "The model response was not completed.",
          details: response.incomplete_details
            ? JSON.stringify(response.incomplete_details)
            : response.status,
        },
        { status: 502 },
      );
    }

    const rawOutput = response.output_text?.trim() ?? "";
    if (!rawOutput) {
      return Response.json(
        { error: "Empty model output.", details: "No text returned from the model." },
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

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

function comicVineApiKey() {
  return process.env.COMIC_VINE_API_KEY;
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

type ComicVineIssue = {
  issue_number?: string | null;
  name?: string | null;
  cover_date?: string | null;
  store_date?: string | null;
  character_credits?: Array<{ name?: string | null }> | null;
  volume?: { name?: string | null } | null;
};

type ComicVineSearchResponse = {
  status_code?: number;
  results?: ComicVineIssue[];
};

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeIssueNumber(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

function extractYear(dateString?: string | null) {
  if (!dateString) {
    return null;
  }
  const match = dateString.match(/\b(19|20)\d{2}\b/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function scoreComicVineIssue(
  issue: ComicVineIssue,
  expectedTitle: string,
  expectedIssue: string,
) {
  let score = 0;
  const normalizedTitle = normalizeTitle(expectedTitle);
  const normalizedIssue = normalizeIssueNumber(expectedIssue);
  const issueNumber = normalizeIssueNumber(issue.issue_number ?? "");
  const issueName = normalizeTitle(issue.name ?? "");
  const volumeName = normalizeTitle(issue.volume?.name ?? "");

  if (issueNumber && issueNumber === normalizedIssue) {
    score += 80;
  }

  if (normalizedTitle && volumeName.includes(normalizedTitle)) {
    score += 30;
  }

  if (normalizedTitle && issueName.includes(normalizedTitle)) {
    score += 15;
  }

  if (extractYear(issue.cover_date) || extractYear(issue.store_date)) {
    score += 5;
  }

  return score;
}

type ComicVineFallbackData = {
  year: number | null;
  keyCharacters: string[];
};

async function lookupIssueDataFromComicVine(
  title: string,
  issueNumber: string,
): Promise<ComicVineFallbackData | null> {
  const apiKey = comicVineApiKey();
  if (!apiKey) {
    return null;
  }

  const query = `${title} ${issueNumber}`;
  const url = new URL("https://comicvine.gamespot.com/api/search/");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("resources", "issue");
  url.searchParams.set("limit", "10");
  url.searchParams.set(
    "field_list",
    "issue_number,name,cover_date,store_date,character_credits,volume",
  );
  url.searchParams.set("query", query);

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "ComicInfo/1.0",
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as ComicVineSearchResponse;
  const issues = Array.isArray(payload.results) ? payload.results : [];
  if (issues.length === 0) {
    return null;
  }

  const sortedByMatch = [...issues].sort(
    (a, b) =>
      scoreComicVineIssue(b, title, issueNumber) -
      scoreComicVineIssue(a, title, issueNumber),
  );
  const best = sortedByMatch[0];
  const year = extractYear(best.cover_date) ?? extractYear(best.store_date);

  const keyCharacters = (best.character_credits ?? [])
    .map((entry) => (entry.name ?? "").trim())
    .filter((name) => name.length > 0)
    .slice(0, 10);

  return { year, keyCharacters };
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

    const modelName = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
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
    if (parsed.title && parsed.issueNumber) {
      const fallbackData = await lookupIssueDataFromComicVine(
        parsed.title,
        parsed.issueNumber,
      );
      if (fallbackData) {
        if (parsed.year === null && fallbackData.year !== null) {
          parsed.year = fallbackData.year;
        }
        if (fallbackData.keyCharacters.length > 0) {
          parsed.keyCharacters = fallbackData.keyCharacters;
        }

        const notes: string[] = [];
        if (fallbackData.year !== null) {
          notes.push("Year from Comic Vine fallback.");
        }
        if (fallbackData.keyCharacters.length > 0) {
          notes.push("Key characters sourced from Comic Vine.");
        }
        if (parsed.keyEvents.length > 0) {
          notes.push("Key plot points from Gemini visual analysis.");
        }
        if (notes.length > 0) {
          parsed.confidenceNotes = parsed.confidenceNotes
            ? `${parsed.confidenceNotes} | ${notes.join(" ")}`
            : notes.join(" ");
        }
      }
    }

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

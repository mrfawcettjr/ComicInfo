import { GoogleGenerativeAI, SchemaType, type ObjectSchema } from "@google/generative-ai";
import sharp from "sharp";

import { comicIdentificationSchema } from "@/lib/comic-schema";
import { extractJsonFromModelOutput } from "@/lib/extract-model-json";

export const runtime = "nodejs";

const MAX_IMAGES = 4;
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
    "You are reading comic book cover photos (up to four images). Extract only identifying metadata.",
    "Use only details visible in the images. Do not guess.",
    "Return a JSON object with exactly these fields:",
    "title (string or null): comic or series name as shown on the cover.",
    "issueNumber (string or null): issue number as printed.",
    "year (number or null): publication year if visible (cover date, copyright, or indicia).",
    "month (string or null): publication month if visible; use full month name (January, February, ...).",
    "volumeOrSeries (string or null): volume number, series label, or series name if visible (e.g. 'Vol. 2', 'Amazing Spider-Man').",
    "If something is not visible or uncertain, set it to null.",
  ].join(" ");
}

const comicResponseSchema: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING, nullable: true },
    issueNumber: { type: SchemaType.STRING, nullable: true },
    year: { type: SchemaType.INTEGER, nullable: true },
    month: { type: SchemaType.STRING, nullable: true },
    volumeOrSeries: { type: SchemaType.STRING, nullable: true },
  },
  required: ["title", "issueNumber", "year", "month", "volumeOrSeries"],
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
  volume?: { name?: string | null } | null;
};

type ComicVineSearchResponse = {
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

async function enrichFromComicVine(
  title: string,
  issueNumber: string,
): Promise<{ year: number | null; volumeOrSeries: string | null } | null> {
  const apiKey = comicVineApiKey();
  if (!apiKey) {
    return null;
  }

  const url = new URL("https://comicvine.gamespot.com/api/search/");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("resources", "issue");
  url.searchParams.set("limit", "10");
  url.searchParams.set(
    "field_list",
    "issue_number,name,cover_date,store_date,volume",
  );
  url.searchParams.set("query", `${title} ${issueNumber}`);

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
  const volumeOrSeries = best.volume?.name?.trim() ?? null;

  return { year, volumeOrSeries };
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

    const parsed = comicIdentificationSchema.parse(parsedJson);

    if (parsed.title && parsed.issueNumber) {
      const enrich = await enrichFromComicVine(parsed.title, parsed.issueNumber);
      if (enrich) {
        if (parsed.year === null && enrich.year !== null) {
          parsed.year = enrich.year;
        }
        if (
          (!parsed.volumeOrSeries || !parsed.volumeOrSeries.trim()) &&
          enrich.volumeOrSeries
        ) {
          parsed.volumeOrSeries = enrich.volumeOrSeries;
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

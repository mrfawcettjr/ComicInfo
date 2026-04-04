import { GoogleGenerativeAI, SchemaType, type ObjectSchema } from "@google/generative-ai";

import {
  issueSummarySchema,
  lookupRequestSchema,
  type IssueSummary,
  type LookupRequest,
} from "@/lib/comic-schema";
import {
  appendComicInfoRowToGoogleSheet,
  isGoogleSheetsExportConfigured,
} from "@/lib/google-sheets-export";
import { extractJsonFromModelOutput } from "@/lib/extract-model-json";

export const runtime = "nodejs";

const BRAVE_WEB_SEARCH = "https://api.search.brave.com/res/v1/web/search";

const MAX_SNIPPET_CHARS = 600;
const MAX_EVIDENCE_CHARS = 14_000;

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
};

type BraveWebSearchResponse = {
  query?: { original?: string };
  web?: { results?: BraveWebResult[] };
};

type SearchHit = {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
};

function braveSearchApiKey() {
  return (
    process.env.ComicInfo_Brave_Search ??
    process.env.BRAVE_SEARCH_API_KEY ??
    process.env.BRAVE_API_KEY
  );
}

function geminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

function geminiModelName() {
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

function buildSearchQuery(body: {
  title?: string | null;
  issueNumber?: string | null;
  year?: number | string | null;
  month?: string | null;
  volumeOrSeries?: string | null;
}) {
  const parts: string[] = [];
  if (body.title?.trim()) {
    parts.push(body.title.trim());
  }
  if (body.volumeOrSeries?.trim()) {
    parts.push(body.volumeOrSeries.trim());
  }
  if (body.issueNumber?.trim()) {
    parts.push(`#${body.issueNumber.trim()}`);
  }
  if (body.month?.trim()) {
    parts.push(body.month.trim());
  }
  if (body.year !== null && body.year !== undefined && body.year !== "") {
    parts.push(String(body.year));
  }
  return parts.join(" ").trim() || "comic book";
}

function formatIssueIdentity(issue: LookupRequest, baseQuery: string) {
  const lines = [
    `Canonical label: "${baseQuery}"`,
    `Title (series): ${issue.title ?? "—"}`,
    `Issue number: ${issue.issueNumber ?? "—"}`,
    `Volume / series label: ${issue.volumeOrSeries ?? "—"}`,
    `Month: ${issue.month ?? "—"}`,
    `Year: ${issue.year !== undefined && issue.year !== null && issue.year !== "" ? String(issue.year) : "—"}`,
  ];
  return lines.join("\n");
}

function displayLinkFromUrl(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function snippetFromBraveResult(result: BraveWebResult) {
  const chunks = [result.description, ...(result.extra_snippets ?? [])].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  return chunks.join(" ").trim();
}

async function braveWebSearch(apiKey: string, q: string, count: number) {
  const url = new URL(BRAVE_WEB_SEARCH);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
  url.searchParams.set("extra_snippets", "true");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    cache: "no-store",
  });

  const data = (await response.json()) as BraveWebSearchResponse & {
    message?: string;
  };

  if (!response.ok) {
    const detail =
      typeof data.message === "string"
        ? data.message
        : response.statusText || "Brave Search request failed.";
    throw new Error(detail);
  }

  return data;
}

function mapBraveResults(results: BraveWebResult[] | undefined): SearchHit[] {
  return (results ?? []).map((item) => {
    const link = item.url ?? "";
    return {
      title: item.title ?? "",
      link,
      snippet: snippetFromBraveResult(item),
      displayLink: displayLinkFromUrl(link),
    };
  });
}

function truncate(text: string, max: number) {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max)}…`;
}

function buildEvidenceBlock(items: SearchHit[]) {
  const chunks: string[] = [];
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    const hit = items[i];
    const piece = [
      `[${i + 1}] ${hit.title}`,
      hit.link ? `URL: ${hit.link}` : "",
      hit.snippet ? `Text: ${truncate(hit.snippet, MAX_SNIPPET_CHARS)}` : "Text: (empty)",
    ]
      .filter(Boolean)
      .join("\n");
    if (total + piece.length > MAX_EVIDENCE_CHARS) {
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }
  return chunks.join("\n\n---\n\n");
}

const issueSummaryResponseSchema: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    keyFeatures: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    stories: { type: SchemaType.STRING },
    caveat: { type: SchemaType.STRING, nullable: true },
    keyCharacters: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    whatMadeSpecial: {
      type: SchemaType.OBJECT,
      properties: {
        debutsRevelationsAndDeaths: { type: SchemaType.STRING },
        significantCharacterMoments: { type: SchemaType.STRING },
        overallSignificance: { type: SchemaType.STRING },
        collectorValue: { type: SchemaType.STRING },
      },
      required: [
        "debutsRevelationsAndDeaths",
        "significantCharacterMoments",
        "overallSignificance",
        "collectorValue",
      ],
    },
  },
  required: ["keyFeatures", "stories", "caveat", "keyCharacters", "whatMadeSpecial"],
};

function buildSummarizerPrompt(identityBlock: string, evidenceBlock: string) {
  return [
    "You summarize web search snippets for ONE comic book issue. The user photographed that issue; the identity below is the only issue you may describe.",
    "",
    "TARGET ISSUE (ground truth — only this issue):",
    identityBlock,
    "",
    "WEB SNIPPETS (noisy; may mention other issues or series — you must filter):",
    evidenceBlock || "(No snippet text was retrieved.)",
    "",
    "Rules:",
    "1. Produce keyFeatures: 3–8 short bullet strings for THIS issue only — notable creators, villains, guest stars, story arc name, key plot hooks, or format (e.g. anniversary issue) when the snippets clearly refer to this issue.",
    "2. Produce stories: 1–3 short paragraphs describing plot/story content for THIS issue only. If snippets mix multiple issues, include only what matches the TARGET issue; if you cannot isolate it, write minimal text and explain in caveat.",
    "3. Produce keyCharacters: 0–10 character names (heroes, villains, supporting) clearly tied to THIS issue in the snippets — use common names (e.g. 'Spider-Man' not only 'Peter Parker' unless the snippet emphasizes it). No duplicates; empty array if none can be confirmed from snippets.",
    "4. Produce whatMadeSpecial as an object with four string fields (use empty strings when unsupported):",
    "   debutsRevelationsAndDeaths — first appearances or debuts, deaths or apparent deaths, surprise revelations or twists, and origin-story beats clearly tied to THIS issue.",
    "   significantCharacterMoments — notable scenes, confrontations, alliances, or emotional beats for characters in THIS issue (not a full plot recap).",
    "   overallSignificance — why this issue matters in its run, event, or wider mythos when the snippets say so (e.g. turning point, finale, tie-in).",
    "   collectorValue — what could make this copy more sought-after or valuable to collectors when inferable from snippets: key issue status, recognized firsts, creative team, printings, awards, or demand signals. Do not invent prices, grades, or census numbers.",
    "5. Ignore or discard information about other issue numbers, other volumes, collections, omnibuses, or unrelated series with similar names.",
    "6. Do not invent facts not supported by the snippets. If evidence is too thin for this exact issue, use empty keyFeatures and a brief stories paragraph saying so, and set caveat to explain.",
    "7. caveat: null if confident; otherwise a brief note (e.g. snippets mostly referred to another issue).",
    "",
    "Return JSON only matching the schema.",
  ].join("\n");
}

async function summarizeIssueWithGemini(
  issue: LookupRequest,
  baseQuery: string,
  items: SearchHit[],
): Promise<{ summary: IssueSummary } | { error: string }> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    return { error: "GEMINI_API_KEY is not configured." };
  }

  const identityBlock = formatIssueIdentity(issue, baseQuery);
  const evidenceBlock = buildEvidenceBlock(items);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: geminiModelName(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: issueSummaryResponseSchema,
    },
  });

  const prompt = buildSummarizerPrompt(identityBlock, evidenceBlock);

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const rawOutput = result.response.text()?.trim() ?? "";
    if (!rawOutput) {
      return { error: "Empty summary from the model." };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonFromModelOutput(rawOutput));
    } catch {
      return { error: "Could not parse summary JSON." };
    }

    const parsed = issueSummarySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { error: "Summary did not match the expected shape." };
    }

    return { summary: parsed.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Summary request failed.";
    return { error: message };
  }
}

export async function POST(request: Request) {
  const apiKey = braveSearchApiKey();
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Brave Search is not configured. Set ComicInfo_Brave_Search (or BRAVE_SEARCH_API_KEY) in the environment.",
      },
      { status: 500 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = lookupRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const body = parsed.data;
  const baseQuery = buildSearchQuery(body);
  const tellMeQuery = `Tell me about ${baseQuery}`;

  try {
    const data = await braveWebSearch(apiKey, tellMeQuery, 10);
    const items = mapBraveResults(data.web?.results);

    let issueSummary: IssueSummary | null = null;
    let summaryError: string | undefined;

    if (items.length === 0) {
      summaryError = "No web results to summarize for this issue.";
    } else {
      const sum = await summarizeIssueWithGemini(body, baseQuery, items);
      if ("summary" in sum) {
        issueSummary = sum.summary;
      } else {
        summaryError = sum.error;
      }
    }

    let sheetExport:
      | { appended: true }
      | { appended: false; error: string }
      | { appended: false; skipped: true };
    if (isGoogleSheetsExportConfigured()) {
      try {
        await appendComicInfoRowToGoogleSheet({
          lookup: body,
          yearIdentified: body.yearIdentified,
          baseQuery,
          tellMeQuery,
          issueSummary,
        });
        sheetExport = { appended: true };
      } catch (sheetErr) {
        sheetExport = {
          appended: false,
          error:
            sheetErr instanceof Error
              ? sheetErr.message
              : "Google Sheets export failed.",
        };
      }
    } else {
      sheetExport = { appended: false, skipped: true };
    }

    return Response.json({
      baseQuery,
      tellMeQuery,
      items,
      issueSummary,
      sheetExport,
      ...(summaryError ? { summaryError } : {}),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Brave Search request failed.";
    return Response.json(
      { error: "Brave search request failed.", details: message },
      { status: 502 },
    );
  }
}

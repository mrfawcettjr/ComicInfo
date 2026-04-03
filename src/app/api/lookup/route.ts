import { lookupRequestSchema } from "@/lib/comic-schema";

export const runtime = "nodejs";

const BRAVE_WEB_SEARCH = "https://api.search.brave.com/res/v1/web/search";

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

function braveSearchApiKey() {
  return (
    process.env.ComicInfo_Brave_Search ??
    process.env.BRAVE_SEARCH_API_KEY ??
    process.env.BRAVE_API_KEY
  );
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

function mapBraveResults(results: BraveWebResult[] | undefined) {
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

  const baseQuery = buildSearchQuery(parsed.data);
  const tellMeQuery = `Tell me about ${baseQuery}`;

  try {
    const data = await braveWebSearch(apiKey, tellMeQuery, 10);

    return Response.json({
      baseQuery,
      tellMeQuery,
      items: mapBraveResults(data.web?.results),
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

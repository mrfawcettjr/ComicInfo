import { lookupRequestSchema } from "@/lib/comic-schema";

export const runtime = "nodejs";

type GoogleSearchItem = {
  title?: string;
  link?: string;
  snippet?: string;
  displayLink?: string;
};

type GoogleSearchResponse = {
  items?: GoogleSearchItem[];
  searchInformation?: {
    totalResults?: string;
  };
  error?: { message?: string };
};

function googleSearchConfig() {
  const key =
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY ?? process.env.GOOGLE_API_KEY;
  const cx =
    process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID ??
    process.env.GOOGLE_CSE_ID ??
    process.env.GOOGLE_SEARCH_ENGINE_ID;
  return { key, cx };
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

export async function POST(request: Request) {
  const { key, cx } = googleSearchConfig();
  if (!key || !cx) {
    return Response.json(
      {
        error:
          "Google Programmable Search is not configured. Set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ENGINE_ID.",
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

  const q = buildSearchQuery(parsed.data);
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("num", "10");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const data = (await response.json()) as GoogleSearchResponse;

  if (!response.ok) {
    return Response.json(
      {
        error: "Google search request failed.",
        details: data.error?.message ?? response.statusText,
      },
      { status: 502 },
    );
  }

  const items = (data.items ?? []).map((item) => ({
    title: item.title ?? "",
    link: item.link ?? "",
    snippet: item.snippet ?? "",
    displayLink: item.displayLink ?? "",
  }));

  return Response.json({
    query: q,
    totalResults: data.searchInformation?.totalResults ?? "0",
    items,
  });
}

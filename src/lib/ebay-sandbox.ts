import https from "node:https";

import { comicInfoSheetColumnIndex, type ComicInfoSheetColumn } from "@/lib/sheet-columns";

const SANDBOX_API_BASE = "https://api.sandbox.ebay.com";
const SANDBOX_OAUTH_TOKEN = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

type TokenCache = { accessToken: string; expiresAtMs: number };
let tokenCache: TokenCache | null = null;

function ebayEnv() {
  return {
    clientId: process.env.EBAY_SANDBOX_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.EBAY_SANDBOX_CLIENT_SECRET?.trim() ?? "",
    refreshToken: process.env.EBAY_SANDBOX_REFRESH_TOKEN?.trim() ?? "",
    fulfillmentPolicyId: process.env.EBAY_SANDBOX_FULFILLMENT_POLICY_ID?.trim() ?? "",
    paymentPolicyId: process.env.EBAY_SANDBOX_PAYMENT_POLICY_ID?.trim() ?? "",
    returnPolicyId: process.env.EBAY_SANDBOX_RETURN_POLICY_ID?.trim() ?? "",
    defaultCategoryId:
      process.env.EBAY_SANDBOX_DEFAULT_CATEGORY_ID?.trim() || "261186",
    merchantLocationKey: process.env.EBAY_SANDBOX_MERCHANT_LOCATION_KEY?.trim() ?? "",
    marketplaceId: process.env.EBAY_SANDBOX_MARKETPLACE_ID?.trim() || "EBAY_US",
  };
}

export function isEbaySandboxListingConfigured(): boolean {
  const e = ebayEnv();
  return Boolean(
    e.clientId &&
      e.clientSecret &&
      e.refreshToken &&
      e.fulfillmentPolicyId &&
      e.paymentPolicyId &&
      e.returnPolicyId,
  );
}

function col(row: string[], name: ComicInfoSheetColumn): string {
  return row[comicInfoSheetColumnIndex(name)]?.trim() ?? "";
}

function parseMoney(raw: string): { value: string; currency: string } | null {
  const t = raw.replace(/[$,\s]/g, "").trim();
  if (!t) {
    return null;
  }
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return { value: n.toFixed(2), currency: "USD" };
}

function parseImageUrls(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/[\n|,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//i.test(s))
    .slice(0, 12);
}

/** Positive integer from the sheet `quantity` column (used for inventory + offer). */
function parseAvailableQuantity(raw: string): number {
  const t = raw.replace(/[, ]/g, "").trim();
  if (!t) {
    throw new Error('Sheet row must include a positive integer in "quantity".');
  }
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('Sheet "quantity" must be a positive integer.');
  }
  return n;
}

function buildSku(rowId: string): string {
  const compact = rowId.replace(/-/g, "");
  const sku = `CI${compact}`;
  return sku.length <= 50 ? sku : sku.slice(0, 50);
}

function pickInventoryCondition(): string {
  /** Inventory API condition enums; comics are usually pre-owned. */
  return "USED_GOOD";
}

function buildTitle(row: string[]): string {
  const custom = col(row, "ebay_title");
  if (custom) {
    return custom.slice(0, 80);
  }
  const title = col(row, "comic_title");
  const issue = col(row, "issue_number");
  const parts = [title, issue ? `#${issue}` : ""].filter(Boolean);
  const built = parts.join(" ").trim();
  return (built || "Comic book listing").slice(0, 80);
}

function buildDescription(row: string[]): string {
  const custom = col(row, "ebay_description_plain");
  if (custom) {
    return custom;
  }
  const blocks = [
    col(row, "stories"),
    col(row, "caveat") ? `Note: ${col(row, "caveat")}` : "",
    col(row, "physical_condition")
      ? `Condition (seller assessment): ${col(row, "physical_condition")}`
      : "",
    col(row, "condition_notes") ? `Details: ${col(row, "condition_notes")}` : "",
    col(row, "cgc_grade_range")
      ? `CGC-style estimate (not a slab grade): ${col(row, "cgc_grade_range")}`
      : "",
  ];
  return blocks.filter(Boolean).join("\n\n").trim() || "See photos and title.";
}

async function getSandboxAccessToken(): Promise<string> {
  const e = ebayEnv();
  if (!e.clientId || !e.clientSecret || !e.refreshToken) {
    throw new Error("eBay sandbox OAuth is not fully configured.");
  }

  if (tokenCache && Date.now() < tokenCache.expiresAtMs - 60_000) {
    return tokenCache.accessToken;
  }

  const basic = Buffer.from(`${e.clientId}:${e.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: e.refreshToken,
  });

  const res = await fetch(SANDBOX_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await res.text();
  let data: { access_token?: string; expires_in?: number; error_description?: string };
  try {
    data = text ? (JSON.parse(text) as typeof data) : {};
  } catch {
    throw new Error(`eBay token response was not JSON (${res.status}).`);
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ?? `eBay OAuth failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }

  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  tokenCache = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  };
  return data.access_token;
}

function flattenHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) {
    return {};
  }
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(h)) {
    return Object.fromEntries(h);
  }
  return { ...h };
}

/**
 * eBay Inventory rejects auto-injected `Accept-Language` from Node's global `fetch`.
 * Use `https.request` so only the headers we set are sent.
 */
async function ebayFetch(
  path: string,
  init: RequestInit,
  marketplaceId: string,
): Promise<Response> {
  const token = await getSandboxAccessToken();
  const method = (init.method ?? "GET").toUpperCase();
  const bodyStr =
    typeof init.body === "string"
      ? init.body
      : init.body != null
        ? String(init.body)
        : undefined;
  const bodyBuffer = bodyStr ? Buffer.from(bodyStr, "utf8") : undefined;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    ...flattenHeaders(init.headers),
  };
  if (bodyBuffer) {
    headers["Content-Length"] = String(bodyBuffer.byteLength);
  }

  const urlPath = path.startsWith("/") ? path : `/${path}`;

  const { statusCode, responseBody } = await new Promise<{
    statusCode: number;
    responseBody: string;
  }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.sandbox.ebay.com",
        port: 443,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });

  return new Response(responseBody, {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

async function readEbayError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as {
      errors?: Array<{ message?: string; longMessage?: string }>;
    };
    const parts =
      data.errors?.map((e) => e.longMessage ?? e.message).filter(Boolean) ?? [];
    if (parts.length) {
      return parts.join("; ");
    }
  } catch {
    /* ignore */
  }
  return text.slice(0, 500) || res.statusText;
}

export type SandboxAuctionResult = {
  offerId: string;
  listingId: string;
  sku: string;
};

export async function createSandboxSevenDayAuctionFromSheetRow(
  row: string[],
): Promise<SandboxAuctionResult> {
  const e = ebayEnv();
  if (!isEbaySandboxListingConfigured()) {
    throw new Error("eBay sandbox listing is not configured on the server.");
  }

  const rowId = col(row, "row_id");
  if (!rowId) {
    throw new Error("Sheet row is missing row_id.");
  }

  const sku = buildSku(rowId);
  const title = buildTitle(row);
  const description = buildDescription(row);

  const currencyRaw = col(row, "currency") || "USD";
  const priceRaw = col(row, "price");
  const parsed = parseMoney(priceRaw);
  if (!parsed) {
    throw new Error(
      'Sheet row must include a positive numeric "price" (auction starting price).',
    );
  }
  if (currencyRaw.toUpperCase() !== "USD") {
    throw new Error('Only USD currency is supported for this integration (set currency to "USD").');
  }

  const imageUrls = parseImageUrls(col(row, "photo_urls"));
  if (imageUrls.length === 0) {
    throw new Error(
      'Sheet row must include at least one HTTPS URL in "photo_urls" (pipe, comma, or newline separated).',
    );
  }

  const categoryId = col(row, "ebay_category_id") || e.defaultCategoryId;
  const merchantLocationKey =
    col(row, "merchant_location_key") || e.merchantLocationKey;
  if (!merchantLocationKey) {
    throw new Error(
      'Set "merchant_location_key" on the sheet row or EBAY_SANDBOX_MERCHANT_LOCATION_KEY in the environment.',
    );
  }

  const availableQuantity = parseAvailableQuantity(col(row, "quantity"));

  const inventoryBody = {
    availability: {
      shipToLocationAvailability: {
        quantity: availableQuantity,
      },
    },
    condition: pickInventoryCondition(),
    product: {
      title,
      description,
      imageUrls,
    },
  };

  const invRes = await ebayFetch(
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      method: "PUT",
      body: JSON.stringify(inventoryBody),
    },
    e.marketplaceId,
  );

  if (!invRes.ok) {
    throw new Error(`createOrReplaceInventoryItem: ${await readEbayError(invRes)}`);
  }

  const offerBody = {
    sku,
    marketplaceId: e.marketplaceId,
    format: "AUCTION",
    listingDuration: "DAYS_7",
    availableQuantity,
    categoryId,
    merchantLocationKey,
    listingPolicies: {
      fulfillmentPolicyId: e.fulfillmentPolicyId,
      paymentPolicyId: e.paymentPolicyId,
      returnPolicyId: e.returnPolicyId,
    },
    pricingSummary: {
      auctionStartPrice: {
        value: parsed.value,
        currency: parsed.currency,
      },
    },
  };

  const offerRes = await ebayFetch(
    "/sell/inventory/v1/offer",
    {
      method: "POST",
      body: JSON.stringify(offerBody),
    },
    e.marketplaceId,
  );

  const offerText = await offerRes.text();
  let offerJson: { offerId?: string };
  try {
    offerJson = offerText ? (JSON.parse(offerText) as typeof offerJson) : {};
  } catch {
    throw new Error(`createOffer: invalid JSON (${offerRes.status})`);
  }

  if (!offerRes.ok || !offerJson.offerId) {
    throw new Error(`createOffer (${offerRes.status}): ${offerText.slice(0, 1200)}`);
  }

  const offerId = offerJson.offerId;

  const publishRes = await ebayFetch(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    { method: "POST" },
    e.marketplaceId,
  );

  const publishText = await publishRes.text();
  let publishJson: { listingId?: string };
  try {
    publishJson = publishText ? (JSON.parse(publishText) as typeof publishJson) : {};
  } catch {
    throw new Error(`publishOffer: invalid JSON (${publishRes.status})`);
  }

  if (!publishRes.ok) {
    throw new Error(`publishOffer (${publishRes.status}): ${publishText.slice(0, 1200)}`);
  }

  const listingId = publishJson.listingId ?? "";
  if (!listingId) {
    throw new Error(
      `publishOffer succeeded but listingId was not returned. Body: ${publishText.slice(0, 400)}`,
    );
  }

  return { offerId, listingId, sku };
}

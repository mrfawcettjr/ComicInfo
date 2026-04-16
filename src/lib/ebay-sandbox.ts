import https from "node:https";

import { comicInfoSheetColumnIndex, type ComicInfoSheetColumn } from "@/lib/sheet-columns";

const SANDBOX_API_HOST = "api.sandbox.ebay.com";
const SANDBOX_APIM_HOST = "apim.sandbox.ebay.com";
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

/**
 * Google Drive "share" links point at HTML viewers; eBay Media API must fetch raw image bytes.
 * Converts `/file/d/{id}/…` and `open?id=` to `uc?export=view&id=…`.
 */
function normalizePhotoUrlForEbayMediaUpload(url: string): string {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes("drive.google.com")) {
      return u;
    }
    const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/i);
    if (fileMatch?.[1]) {
      return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileMatch[1])}`;
    }
    const openId = parsed.searchParams.get("id");
    if (openId && parsed.pathname.includes("/open")) {
      return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(openId)}`;
    }
  } catch {
    /* keep original */
  }
  return u;
}

function isAlreadyEpsImageUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h.includes("ebayimg.com") || h.includes("ebaystatic.com");
  } catch {
    return false;
  }
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

/** ComicInfo sandbox listings use SKUs from `buildSku` (`CI` + alphanumeric, max 50). */
export function isComicInfoSandboxSku(sku: string): boolean {
  const s = sku.trim();
  return (
    s.startsWith("CI") &&
    s.length >= 3 &&
    s.length <= 50 &&
    /^CI[A-Za-z0-9]+$/.test(s)
  );
}

export type SandboxResetResult = {
  ciSkusFound: number;
  skusProcessed: number;
  offersRemoved: number;
  errors: string[];
};

/**
 * Sandbox only: lists inventory via Inventory API on `api.sandbox.ebay.com`, finds SKUs matching
 * `isComicInfoSandboxSku`, withdraws published offers, deletes offers, then deletes inventory items.
 */
export async function resetSandboxComicInfoSkus(): Promise<SandboxResetResult> {
  if (!isEbaySandboxListingConfigured()) {
    throw new Error("eBay sandbox listing is not configured on the server.");
  }
  const e = ebayEnv();
  const marketplaceId = e.marketplaceId;
  const limit = 100;
  const ciSkus = new Set<string>();

  for (let page = 0; page < 10_000; page++) {
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(page),
    });
    const invRes = await ebayFetch(
      `/sell/inventory/v1/inventory_item?${qs.toString()}`,
      { method: "GET" },
      marketplaceId,
    );
    const invText = await invRes.text();
    if (!invRes.ok) {
      throw new Error(`getInventoryItems: ${await readEbayError(invRes)}`);
    }
    let invData: { inventoryItems?: Array<{ sku?: string }> };
    try {
      invData = invText ? (JSON.parse(invText) as typeof invData) : {};
    } catch {
      throw new Error(`getInventoryItems: invalid JSON (${invRes.status})`);
    }
    const items = invData.inventoryItems ?? [];
    if (items.length === 0) {
      break;
    }
    for (const item of items) {
      const sku = item.sku?.trim();
      if (sku && isComicInfoSandboxSku(sku)) {
        ciSkus.add(sku);
      }
    }
    if (items.length < limit) {
      break;
    }
  }

  const errors: string[] = [];
  let offersRemoved = 0;
  let skusProcessed = 0;

  for (const sku of ciSkus) {
    skusProcessed += 1;
    const offerQs = new URLSearchParams({ sku });
    const offRes = await ebayFetch(
      `/sell/inventory/v1/offer?${offerQs.toString()}`,
      { method: "GET" },
      marketplaceId,
    );
    const offText = await offRes.text();
    let offers: Array<{ offerId?: string; listing?: { listingId?: string } | null }> = [];
    if (offRes.ok && offText) {
      try {
        const offData = JSON.parse(offText) as { offers?: typeof offers };
        offers = offData.offers ?? [];
      } catch {
        errors.push(`getOffers ${sku}: invalid JSON`);
      }
    } else if (offRes.status !== 404) {
      errors.push(`getOffers ${sku}: ${offText.slice(0, 300) || offRes.status}`);
    }

    for (const offer of offers) {
      const offerId = offer.offerId?.trim();
      if (!offerId) {
        continue;
      }
      if (offer.listing?.listingId) {
        const wRes = await ebayFetch(
          `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
          { method: "POST" },
          marketplaceId,
        );
        if (!wRes.ok) {
          const wMsg = await readEbayError(wRes);
          if (!/not published|already ended|invalid|unpublished/i.test(wMsg)) {
            errors.push(`withdrawOffer ${offerId}: ${wMsg}`);
          }
        }
      }
      const dRes = await ebayFetch(
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        { method: "DELETE" },
        marketplaceId,
      );
      if (dRes.ok || dRes.status === 204) {
        offersRemoved += 1;
      } else {
        errors.push(`deleteOffer ${offerId}: ${await readEbayError(dRes)}`);
      }
    }

    const delInv = await ebayFetch(
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      { method: "DELETE" },
      marketplaceId,
    );
    if (!delInv.ok && delInv.status !== 404) {
      errors.push(`deleteInventoryItem ${sku}: ${await readEbayError(delInv)}`);
    }
  }

  return {
    ciSkusFound: ciSkus.size,
    skusProcessed,
    offersRemoved,
    errors,
  };
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

/** Item specific for categories that require "Book Title" (Inventory `product.aspects` values max 50 chars). */
function buildBookTitleAspect(row: string[]): string {
  const title = col(row, "comic_title");
  const issue = col(row, "issue_number");
  const parts = [title, issue ? `#${issue}` : ""].filter(Boolean);
  const built = parts.join(" ").trim();
  return (built || "Comic book").slice(0, 50);
}

function buildAuthorAspect(row: string[]): string {
  const custom = col(row, "ebay_author").trim();
  if (custom) {
    return custom.slice(0, 50);
  }
  return "Does not apply";
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

type EbayApiResult = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type ListingInputs = {
  sku: string;
  title: string;
  description: string;
  categoryId: string;
  merchantLocationKey: string;
  availableQuantity: number;
  parsedPrice: { value: string; currency: string };
};

/**
 * eBay Inventory rejects auto-injected `Accept-Language` from Node's global `fetch`.
 * Use `https.request` so only the headers we set are sent.
 *
 * Returns a minimal stand-in instead of `Response` so HTTP 204 (Inventory PUT success)
 * does not trip runtimes that reject `new Response(..., { status: 204 })`.
 */
async function ebayFetch(
  path: string,
  init: RequestInit,
  marketplaceId: string,
  options?: { host?: string },
): Promise<EbayApiResult> {
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
    "Content-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    ...flattenHeaders(init.headers),
  };
  if (bodyBuffer) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(bodyBuffer.byteLength);
  }

  const urlPath = path.startsWith("/") ? path : `/${path}`;
  const hostname = options?.host ?? SANDBOX_API_HOST;

  const { statusCode, responseBody } = await new Promise<{
    statusCode: number;
    responseBody: string;
  }>((resolve, reject) => {
    const req = https.request(
      {
        hostname,
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

  const ok = statusCode >= 200 && statusCode < 300;
  return {
    ok,
    status: statusCode,
    text: async () => responseBody,
  };
}

async function readEbayError(res: EbayApiResult): Promise<string> {
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
  return text.slice(0, 500) || String(res.status);
}

/**
 * Uploads a sheet-hosted URL via [createImageFromUrl](https://developer.ebay.com/api-docs/commerce/media/resources/image/methods/createImageFromUrl)
 * (sandbox: `apim.sandbox.ebay.com`) and returns the EPS `imageUrl` for Inventory `product.imageUrls`.
 */
async function createEpsImageFromUrl(
  sheetUrl: string,
  marketplaceId: string,
): Promise<string> {
  const trimmed = sheetUrl.trim();
  if (isAlreadyEpsImageUrl(trimmed)) {
    return trimmed;
  }
  const imageUrl = normalizePhotoUrlForEbayMediaUpload(trimmed);
  const res = await ebayFetch(
    "/commerce/media/v1_beta/image/create_image_from_url",
    {
      method: "POST",
      body: JSON.stringify({ imageUrl }),
    },
    marketplaceId,
    { host: SANDBOX_APIM_HOST },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`createImageFromUrl (${res.status}): ${text.slice(0, 800)}`);
  }
  let data: { imageUrl?: string; maxDimensionImageUrl?: string };
  try {
    data = text ? (JSON.parse(text) as typeof data) : {};
  } catch {
    throw new Error(`createImageFromUrl: invalid JSON (${res.status})`);
  }
  const eps = data.maxDimensionImageUrl?.trim() || data.imageUrl?.trim();
  if (!eps) {
    throw new Error(
      "createImageFromUrl: missing maxDimensionImageUrl/imageUrl in response.",
    );
  }
  return eps;
}

async function resolvePhotoUrlsToEps(
  urls: string[],
  marketplaceId: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const u of urls) {
    out.push(await createEpsImageFromUrl(u, marketplaceId));
  }
  return out;
}

async function createEpsImageFromFile(
  file: File,
  marketplaceId: string,
): Promise<string> {
  const token = await getSandboxAccessToken();
  const boundary = `----comicinfo-${Math.random().toString(16).slice(2)}`;
  const filename = (file.name || "upload.jpg").replace(/"/g, "");
  const mimeType = file.type?.trim() || "application/octet-stream";
  const fileBytes = Buffer.from(await file.arrayBuffer());
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(head, "utf8"),
    fileBytes,
    Buffer.from(tail, "utf8"),
  ]);

  const { statusCode, responseBody } = await new Promise<{
    statusCode: number;
    responseBody: string;
  }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: SANDBOX_APIM_HOST,
        port: 443,
        path: "/commerce/media/v1_beta/image/create_image_from_file",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(bodyBuffer.byteLength),
          "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(bodyBuffer);
    req.end();
  });

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`createImageFromFile (${statusCode}): ${responseBody.slice(0, 800)}`);
  }
  let data: { imageUrl?: string; maxDimensionImageUrl?: string };
  try {
    data = responseBody ? (JSON.parse(responseBody) as typeof data) : {};
  } catch {
    throw new Error(`createImageFromFile: invalid JSON (${statusCode})`);
  }
  const eps = data.maxDimensionImageUrl?.trim() || data.imageUrl?.trim();
  if (!eps) {
    throw new Error(
      "createImageFromFile: missing maxDimensionImageUrl/imageUrl in response.",
    );
  }
  return eps;
}

async function resolveFilesToEps(
  files: File[],
  marketplaceId: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    out.push(await createEpsImageFromFile(file, marketplaceId));
  }
  return out;
}

function buildListingInputsFromRow(row: string[]): ListingInputs {
  const e = ebayEnv();
  const rowId = col(row, "row_id");
  if (!rowId) {
    throw new Error("Sheet row is missing row_id.");
  }

  const currencyRaw = col(row, "currency") || "USD";
  const priceRaw = col(row, "price");
  const parsedPrice = parseMoney(priceRaw);
  if (!parsedPrice) {
    throw new Error(
      'Sheet row must include a positive numeric "price" (auction starting price).',
    );
  }
  if (currencyRaw.toUpperCase() !== "USD") {
    throw new Error('Only USD currency is supported for this integration (set currency to "USD").');
  }

  const merchantLocationKey =
    col(row, "merchant_location_key") || e.merchantLocationKey;
  if (!merchantLocationKey) {
    throw new Error(
      'Set "merchant_location_key" on the sheet row or EBAY_SANDBOX_MERCHANT_LOCATION_KEY in the environment.',
    );
  }

  return {
    sku: buildSku(rowId),
    title: buildTitle(row),
    description: buildDescription(row),
    categoryId: col(row, "ebay_category_id").trim() || e.defaultCategoryId,
    merchantLocationKey,
    availableQuantity: parseAvailableQuantity(col(row, "quantity")),
    parsedPrice,
  };
}

async function createSandboxSevenDayAuctionFromRowWithEpsImages(
  row: string[],
  imageUrls: string[],
): Promise<SandboxAuctionResult> {
  const e = ebayEnv();
  if (!isEbaySandboxListingConfigured()) {
    throw new Error("eBay sandbox listing is not configured on the server.");
  }
  if (imageUrls.length === 0) {
    throw new Error("At least one image is required.");
  }
  const inputs = buildListingInputsFromRow(row);
  const inventoryBody = {
    availability: {
      shipToLocationAvailability: {
        quantity: inputs.availableQuantity,
      },
    },
    condition: pickInventoryCondition(),
    product: {
      title: inputs.title,
      description: inputs.description,
      imageUrls,
      aspects: {
        "Book Title": [buildBookTitleAspect(row)],
        Language: ["English"],
        Author: [buildAuthorAspect(row)],
      },
    },
  };

  const invRes = await ebayFetch(
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(inputs.sku)}`,
    {
      method: "PUT",
      body: JSON.stringify(inventoryBody),
    },
    e.marketplaceId,
  );

  if (!invRes.ok) {
    throw new Error(`createOrReplaceInventoryItem: ${await readEbayError(invRes)}`);
  }

  // Quantity stays on the inventory item only; auction offers reject `availableQuantity` (eBay error 25762).
  const offerBody = {
    sku: inputs.sku,
    marketplaceId: e.marketplaceId,
    format: "AUCTION",
    listingDuration: "DAYS_7",
    categoryId: inputs.categoryId, // createOffer: from Google Sheet `ebay_category_id` (see above)
    merchantLocationKey: inputs.merchantLocationKey,
    listingPolicies: {
      fulfillmentPolicyId: e.fulfillmentPolicyId,
      paymentPolicyId: e.paymentPolicyId,
      returnPolicyId: e.returnPolicyId,
    },
    pricingSummary: {
      auctionStartPrice: {
        value: inputs.parsedPrice.value,
        currency: inputs.parsedPrice.currency,
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

  let offerId = offerJson.offerId?.trim();
  if (offerRes.ok && offerId) {
    /* new draft */
  } else {
    const existingId = parseOfferIdFromDuplicateCreateOffer(offerText);
    if (!existingId) {
      throw new Error(`createOffer (${offerRes.status}): ${offerText.slice(0, 1200)}`);
    }
    offerId = existingId;
    const updateRes = await ebayFetch(
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      {
        method: "PUT",
        body: JSON.stringify(offerBody),
      },
      e.marketplaceId,
    );
    if (!updateRes.ok) {
      throw new Error(`updateOffer: ${await readEbayError(updateRes)}`);
    }
  }

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

  return { offerId, listingId, sku: inputs.sku, imageUrls };
}

/** eBay returns 25002 with `offerId` when a draft offer already exists for this SKU/format. */
function parseOfferIdFromDuplicateCreateOffer(body: string): string | null {
  try {
    const data = JSON.parse(body) as {
      errors?: Array<{
        errorId?: number;
        message?: string;
        parameters?: Array<{ name?: string; value?: string }>;
      }>;
    };
    for (const err of data.errors ?? []) {
      if (err.errorId !== 25002) {
        continue;
      }
      const msg = err.message ?? "";
      if (!/already exists/i.test(msg)) {
        continue;
      }
      const offerParam = err.parameters?.find((p) => p.name === "offerId");
      if (offerParam?.value?.trim()) {
        return offerParam.value.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export type SandboxAuctionResult = {
  offerId: string;
  listingId: string;
  sku: string;
  imageUrls: string[];
};

export async function createSandboxSevenDayAuctionFromSheetRow(
  row: string[],
): Promise<SandboxAuctionResult> {
  const e = ebayEnv();
  if (!isEbaySandboxListingConfigured()) {
    throw new Error("eBay sandbox listing is not configured on the server.");
  }
  const rawPhotoUrls = parseImageUrls(col(row, "photo_urls"));
  if (rawPhotoUrls.length === 0) {
    throw new Error(
      'Sheet row must include at least one HTTPS URL in "photo_urls" (pipe, comma, or newline separated).',
    );
  }
  const imageUrls = await resolvePhotoUrlsToEps(rawPhotoUrls, e.marketplaceId);
  return createSandboxSevenDayAuctionFromRowWithEpsImages(row, imageUrls);
}

export async function createSandboxSevenDayAuctionFromSheetRowAndFiles(
  row: string[],
  files: File[],
): Promise<SandboxAuctionResult> {
  const e = ebayEnv();
  if (!isEbaySandboxListingConfigured()) {
    throw new Error("eBay sandbox listing is not configured on the server.");
  }
  if (files.length === 0) {
    throw new Error("Attach at least one image file.");
  }
  if (files.length > 12) {
    throw new Error("At most 12 images can be uploaded to eBay.");
  }
  const imageUrls = await resolveFilesToEps(files, e.marketplaceId);
  return createSandboxSevenDayAuctionFromRowWithEpsImages(row, imageUrls);
}

import https from "node:https";

import { comicInfoSheetColumnIndex, type ComicInfoSheetColumn } from "@/lib/sheet-columns";

const EBAY_API_HOST = "api.ebay.com";
const EBAY_APIM_HOST = "apim.ebay.com";
const EBAY_OAUTH_TOKEN = "https://api.ebay.com/identity/v1/oauth2/token";

type TokenCache = { accessToken: string; expiresAtMs: number };
let tokenCache: TokenCache | null = null;

function ebayEnv() {
  return {
    clientId: process.env.EBAY_PROD_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.EBAY_PROD_CLIENT_SECRET?.trim() ?? "",
    refreshToken: process.env.EBAY_PROD_REFRESH_TOKEN?.trim() ?? "",
    fulfillmentPolicyId: process.env.EBAY_PROD_FULFILLMENT_POLICY_ID?.trim() ?? "",
    paymentPolicyId: process.env.EBAY_PROD_PAYMENT_POLICY_ID?.trim() ?? "",
    returnPolicyId: process.env.EBAY_PROD_RETURN_POLICY_ID?.trim() ?? "",
    defaultCategoryId: process.env.EBAY_PROD_DEFAULT_CATEGORY_ID?.trim() || "261186",
    merchantLocationKey: process.env.EBAY_PROD_MERCHANT_LOCATION_KEY?.trim() ?? "",
    marketplaceId: process.env.EBAY_PROD_MARKETPLACE_ID?.trim() || "EBAY_US",
    allowProdWrites: process.env.EBAY_ALLOW_PROD_WRITES?.trim().toLowerCase() === "true",
    dryRun: process.env.EBAY_DRY_RUN?.trim().toLowerCase() === "true",
    publishConfirmToken:
      process.env.EBAY_PUBLISH_CONFIRM_TOKEN?.trim() || "PUBLISH_EBAY_PROD",
  };
}

export function isEbayListingConfigured(): boolean {
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

export function isEbayPublishCheckpointPassed(token: string): boolean {
  const expected = ebayEnv().publishConfirmToken;
  return Boolean(token.trim() && token.trim() === expected);
}

export function getEbayPublishCheckpointTokenHint(): string {
  return ebayEnv().publishConfirmToken;
}

function assertEbayProdWritesEnabled() {
  if (!ebayEnv().allowProdWrites) {
    throw new Error(
      "Production writes are disabled. Set EBAY_ALLOW_PROD_WRITES=true when you are ready.",
    );
  }
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

async function getEbayAccessToken(): Promise<string> {
  const e = ebayEnv();
  if (!e.clientId || !e.clientSecret || !e.refreshToken) {
    throw new Error("eBay production OAuth is not fully configured.");
  }
  if (tokenCache && Date.now() < tokenCache.expiresAtMs - 60_000) {
    return tokenCache.accessToken;
  }

  const basic = Buffer.from(`${e.clientId}:${e.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: e.refreshToken,
  });

  const res = await fetch(EBAY_OAUTH_TOKEN, {
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
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
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

async function ebayFetch(
  path: string,
  init: RequestInit,
  marketplaceId: string,
  options?: { host?: string },
): Promise<EbayApiResult> {
  const token = await getEbayAccessToken();
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
  const hostname = options?.host ?? EBAY_API_HOST;
  const { statusCode, responseBody } = await new Promise<{
    statusCode: number;
    responseBody: string;
  }>((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path: urlPath, method, headers },
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
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });

  return {
    ok: statusCode >= 200 && statusCode < 300,
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
    const parts = data.errors?.map((e) => e.longMessage ?? e.message).filter(Boolean) ?? [];
    if (parts.length) return parts.join("; ");
  } catch {
    /* ignore */
  }
  return text.slice(0, 500) || String(res.status);
}

async function createEpsImageFromUrl(
  sheetUrl: string,
  marketplaceId: string,
): Promise<string> {
  const trimmed = sheetUrl.trim();
  if (isAlreadyEpsImageUrl(trimmed)) return trimmed;
  const imageUrl = normalizePhotoUrlForEbayMediaUpload(trimmed);
  const res = await ebayFetch(
    "/commerce/media/v1_beta/image/create_image_from_url",
    { method: "POST", body: JSON.stringify({ imageUrl }) },
    marketplaceId,
    { host: EBAY_APIM_HOST },
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
    throw new Error("createImageFromUrl: missing maxDimensionImageUrl/imageUrl in response.");
  }
  return eps;
}

async function resolvePhotoUrlsToEps(urls: string[], marketplaceId: string): Promise<string[]> {
  const out: string[] = [];
  for (const u of urls) out.push(await createEpsImageFromUrl(u, marketplaceId));
  return out;
}

async function createEpsImageFromFile(file: File, marketplaceId: string): Promise<string> {
  const token = await getEbayAccessToken();
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
        hostname: EBAY_APIM_HOST,
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
    throw new Error("createImageFromFile: missing maxDimensionImageUrl/imageUrl in response.");
  }
  return eps;
}

async function resolveFilesToEps(files: File[], marketplaceId: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) out.push(await createEpsImageFromFile(file, marketplaceId));
  return out;
}

function buildListingInputsFromRow(row: string[]): ListingInputs {
  const e = ebayEnv();
  const rowId = col(row, "row_id");
  if (!rowId) throw new Error("Sheet row is missing row_id.");

  const currencyRaw = col(row, "currency") || "USD";
  const parsedPrice = parseMoney(col(row, "price"));
  if (!parsedPrice) {
    throw new Error('Sheet row must include a positive numeric "price" (auction starting price).');
  }
  if (currencyRaw.toUpperCase() !== "USD") {
    throw new Error('Only USD currency is supported for this integration (set currency to "USD").');
  }
  const merchantLocationKey = col(row, "merchant_location_key") || e.merchantLocationKey;
  if (!merchantLocationKey) {
    throw new Error(
      'Set "merchant_location_key" on the sheet row or EBAY_PROD_MERCHANT_LOCATION_KEY in the environment.',
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
      if (err.errorId !== 25002) continue;
      if (!/already exists/i.test(err.message ?? "")) continue;
      const offerParam = err.parameters?.find((p) => p.name === "offerId");
      if (offerParam?.value?.trim()) return offerParam.value.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

export type EbayAuctionResult = {
  offerId: string;
  listingId: string;
  sku: string;
  imageUrls: string[];
};

async function createSevenDayAuctionFromRowWithEpsImages(
  row: string[],
  imageUrls: string[],
): Promise<EbayAuctionResult> {
  const e = ebayEnv();
  if (!isEbayListingConfigured()) {
    throw new Error("eBay production listing is not configured on the server.");
  }
  assertEbayProdWritesEnabled();
  if (imageUrls.length === 0) throw new Error("At least one image is required.");

  const inputs = buildListingInputsFromRow(row);
  if (e.dryRun) {
    return {
      offerId: `dryrun-offer-${Date.now()}`,
      listingId: `dryrun-listing-${Date.now()}`,
      sku: inputs.sku,
      imageUrls,
    };
  }

  const inventoryBody = {
    availability: { shipToLocationAvailability: { quantity: inputs.availableQuantity } },
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
    { method: "PUT", body: JSON.stringify(inventoryBody) },
    e.marketplaceId,
  );
  if (!invRes.ok) {
    throw new Error(`createOrReplaceInventoryItem: ${await readEbayError(invRes)}`);
  }

  const offerBody = {
    sku: inputs.sku,
    marketplaceId: e.marketplaceId,
    format: "AUCTION",
    listingDuration: "DAYS_7",
    categoryId: inputs.categoryId,
    merchantLocationKey: inputs.merchantLocationKey,
    listingPolicies: {
      fulfillmentPolicyId: e.fulfillmentPolicyId,
      paymentPolicyId: e.paymentPolicyId,
      returnPolicyId: e.returnPolicyId,
    },
    pricingSummary: {
      auctionStartPrice: { value: inputs.parsedPrice.value, currency: inputs.parsedPrice.currency },
    },
  };

  const offerRes = await ebayFetch(
    "/sell/inventory/v1/offer",
    { method: "POST", body: JSON.stringify(offerBody) },
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
  if (!offerRes.ok || !offerId) {
    const existingId = parseOfferIdFromDuplicateCreateOffer(offerText);
    if (!existingId) {
      throw new Error(`createOffer (${offerRes.status}): ${offerText.slice(0, 1200)}`);
    }
    offerId = existingId;
    const updateRes = await ebayFetch(
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      { method: "PUT", body: JSON.stringify(offerBody) },
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

export async function createSevenDayAuctionFromSheetRow(row: string[]): Promise<EbayAuctionResult> {
  const e = ebayEnv();
  if (!isEbayListingConfigured()) {
    throw new Error("eBay production listing is not configured on the server.");
  }
  const rawPhotoUrls = parseImageUrls(col(row, "photo_urls"));
  if (rawPhotoUrls.length === 0) {
    throw new Error(
      'Sheet row must include at least one HTTPS URL in "photo_urls" (pipe, comma, or newline separated).',
    );
  }
  const imageUrls = await resolvePhotoUrlsToEps(rawPhotoUrls, e.marketplaceId);
  return createSevenDayAuctionFromRowWithEpsImages(row, imageUrls);
}

export async function createSevenDayAuctionFromSheetRowAndFiles(
  row: string[],
  files: File[],
): Promise<EbayAuctionResult> {
  const e = ebayEnv();
  if (!isEbayListingConfigured()) {
    throw new Error("eBay production listing is not configured on the server.");
  }
  if (files.length === 0) throw new Error("Attach at least one image file.");
  if (files.length > 12) throw new Error("At most 12 images can be uploaded to eBay.");
  const imageUrls = await resolveFilesToEps(files, e.marketplaceId);
  return createSevenDayAuctionFromRowWithEpsImages(row, imageUrls);
}

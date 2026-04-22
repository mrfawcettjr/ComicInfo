import { z } from "zod";

import {
  createSevenDayAuctionFromSheetRowAndFiles,
  getEbayPublishCheckpointTokenHint,
  isEbayListingConfigured,
  isEbayPublishCheckpointPassed,
} from "@/lib/ebay";
import {
  findComicInfoRowNumberByRowId,
  getComicInfoSheetRow,
  isGoogleSheetsExportConfigured,
  updateComicInfoSheetRowPartial,
} from "@/lib/google-sheets-export";

export const runtime = "nodejs";
const MAX_IMAGES = 12;
const rowIdSchema = z.string().min(1);

function extractImageFiles(form: FormData): File[] {
  const raw = form.getAll("images");
  const out: File[] = [];
  for (const item of raw) {
    if (item instanceof File) {
      out.push(item);
    }
  }
  return out;
}

export async function POST(request: Request) {
  if (!isGoogleSheetsExportConfigured()) {
    return Response.json({ error: "Google Sheets is not configured on the server." }, { status: 503 });
  }
  if (!isEbayListingConfigured()) {
    return Response.json(
      {
        error:
          "eBay production listing is not configured. Set EBAY_PROD_CLIENT_ID, EBAY_PROD_CLIENT_SECRET, EBAY_PROD_REFRESH_TOKEN, and the three production policy IDs.",
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Invalid multipart form data. Send rowId and one or more images." },
      { status: 400 },
    );
  }

  const rowIdParsed = rowIdSchema.safeParse(form.get("rowId"));
  if (!rowIdParsed.success) {
    return Response.json({ error: "Form field rowId is required." }, { status: 400 });
  }
  const rowId = rowIdParsed.data.trim();
  const files = extractImageFiles(form);
  if (files.length === 0) {
    return Response.json({ error: "Attach at least one image in images[]/images." }, { status: 400 });
  }
  if (files.length > MAX_IMAGES) {
    return Response.json({ error: `Attach at most ${MAX_IMAGES} images.` }, { status: 400 });
  }
  const confirmPublishToken = String(form.get("confirmPublishToken") ?? "").trim();
  if (!isEbayPublishCheckpointPassed(confirmPublishToken)) {
    return Response.json(
      {
        error: `Publish checkpoint failed. Type ${getEbayPublishCheckpointTokenHint()} to confirm.`,
      },
      { status: 400 },
    );
  }

  try {
    const rowNumber = await findComicInfoRowNumberByRowId(rowId);
    if (rowNumber === null) {
      return Response.json(
        { error: "No sheet row found with that row_id. Add the row from ComicInfo first." },
        { status: 404 },
      );
    }
    const row = await getComicInfoSheetRow(rowNumber);
    if (!row) {
      return Response.json({ error: "Could not read that sheet row." }, { status: 404 });
    }
    const result = await createSevenDayAuctionFromSheetRowAndFiles(row, files);
    await updateComicInfoSheetRowPartial(rowNumber, {
      pipeline_status: "ebay_prod_listed",
      last_error: "",
      ebay_offer_id: result.offerId,
      ebay_listing_id: result.listingId,
      ebay_sku: result.sku,
      photo_urls: result.imageUrls.join(" | "),
      updated_at: new Date().toISOString(),
    });
    return Response.json({
      ok: true,
      offerId: result.offerId,
      listingId: result.listingId,
      sku: result.sku,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "eBay production listing failed.";
    try {
      const rowNumber = await findComicInfoRowNumberByRowId(rowId);
      if (rowNumber !== null) {
        await updateComicInfoSheetRowPartial(rowNumber, {
          pipeline_status: "ebay_prod_error",
          last_error: message.slice(0, 5000),
          updated_at: new Date().toISOString(),
        });
      }
    } catch {
      /* best-effort sheet update */
    }
    return Response.json({ error: message }, { status: 502 });
  }
}

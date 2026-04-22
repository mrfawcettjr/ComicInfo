import { z } from "zod";

import {
  createSevenDayAuctionFromSheetRow,
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

const bodySchema = z.object({
  rowId: z.string().min(1),
  confirmPublishToken: z.string().min(1),
});

export async function GET() {
  const configured = isEbayListingConfigured();
  return Response.json({
    ebayListingAvailable: configured,
    ebayPublishCheckpointHint: getEbayPublishCheckpointTokenHint(),
  });
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

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Request body must include { rowId, confirmPublishToken }." },
      { status: 400 },
    );
  }

  const { rowId, confirmPublishToken } = parsed.data;
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

    const result = await createSevenDayAuctionFromSheetRow(row);
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

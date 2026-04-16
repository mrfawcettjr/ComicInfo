import { z } from "zod";

import {
  createSandboxSevenDayAuctionFromSheetRow,
  isEbaySandboxListingConfigured,
} from "@/lib/ebay-sandbox";
import {
  findComicInfoRowNumberByRowId,
  getComicInfoSheetRow,
  isGoogleSheetsExportConfigured,
  updateComicInfoSheetRowPartial,
} from "@/lib/google-sheets-export";

export const runtime = "nodejs";

const bodySchema = z.object({
  rowId: z.string().min(1),
});

export async function GET() {
  const configured = isEbaySandboxListingConfigured();
  return Response.json({
    ebaySandboxListingAvailable: configured,
    ebaySandboxResetAvailable: configured,
  });
}

export async function POST(request: Request) {
  if (!isGoogleSheetsExportConfigured()) {
    return Response.json(
      { error: "Google Sheets is not configured on the server." },
      { status: 503 },
    );
  }

  if (!isEbaySandboxListingConfigured()) {
    return Response.json(
      {
        error:
          "eBay sandbox listing is not configured. Set EBAY_SANDBOX_CLIENT_ID, EBAY_SANDBOX_CLIENT_SECRET, EBAY_SANDBOX_REFRESH_TOKEN, and the three sandbox policy IDs.",
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
    return Response.json({ error: "Request body must include { rowId }." }, { status: 400 });
  }

  const { rowId } = parsed.data;

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

    const result = await createSandboxSevenDayAuctionFromSheetRow(row);

    const now = new Date().toISOString();
    await updateComicInfoSheetRowPartial(rowNumber, {
      pipeline_status: "ebay_sandbox_listed",
      last_error: "",
      ebay_offer_id: result.offerId,
      ebay_listing_id: result.listingId,
      ebay_sku: result.sku,
      photo_urls: result.imageUrls.join(" | "),
      updated_at: now,
    });

    return Response.json({
      ok: true,
      offerId: result.offerId,
      listingId: result.listingId,
      sku: result.sku,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "eBay sandbox listing failed.";

    try {
      const rowNumber = await findComicInfoRowNumberByRowId(rowId);
      if (rowNumber !== null) {
        await updateComicInfoSheetRowPartial(rowNumber, {
          pipeline_status: "ebay_sandbox_error",
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

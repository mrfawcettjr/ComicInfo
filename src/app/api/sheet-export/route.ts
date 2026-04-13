import {
  appendComicInfoRowToGoogleSheet,
  isGoogleSheetsExportConfigured,
} from "@/lib/google-sheets-export";
import { sheetExportRequestSchema } from "@/lib/comic-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isGoogleSheetsExportConfigured()) {
    return Response.json(
      { error: "Google Sheets is not configured on the server." },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = sheetExportRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const data = parsed.data;
  const { baseQuery, tellMeQuery, issueSummary, ...lookupFields } = data;

  try {
    const { rowId, rowNumber } = await appendComicInfoRowToGoogleSheet({
      lookup: lookupFields,
      yearIdentified: data.yearIdentified,
      baseQuery,
      tellMeQuery,
      issueSummary,
    });
    return Response.json({ ok: true, rowId, rowNumber });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Google Sheets append failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}

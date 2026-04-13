import { google } from "googleapis";

import {
  COMICINFO_SHEET_COLUMNS,
  COMICINFO_SHEET_COLUMN_COUNT,
  comicInfoSheetColumnIndex,
} from "@/lib/sheet-columns";
import type { IssueSummary, LookupRequest } from "@/lib/comic-schema";

function sheetsEnv() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const credentialsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS?.trim();
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME?.trim() || "Sheet1";
  return { spreadsheetId, credentialsRaw, tabName };
}

export function isGoogleSheetsExportConfigured() {
  const { spreadsheetId, credentialsRaw } = sheetsEnv();
  return Boolean(spreadsheetId && credentialsRaw);
}

function parseRowNumberFromUpdatedRange(range: string | undefined | null): number | null {
  if (!range) {
    return null;
  }
  const m = range.match(/![A-Za-z]+(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function normalizeSheetRow(values: string[] | undefined | null): string[] {
  const row = [...(values ?? [])].map((c) => (c == null ? "" : String(c)));
  while (row.length < COMICINFO_SHEET_COLUMN_COUNT) {
    row.push("");
  }
  return row.slice(0, COMICINFO_SHEET_COLUMN_COUNT);
}

function cellString(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function joinPipe(items: string[]) {
  return items.filter((s) => s.trim().length > 0).join(" | ");
}

export function buildComicInfoSheetRowValues(input: {
  rowId: string;
  createdAtIso: string;
  lookup: LookupRequest;
  yearIdentified: number | string | null | undefined;
  baseQuery: string;
  tellMeQuery: string;
  issueSummary: IssueSummary | null;
}): string[] {
  const { lookup, issueSummary } = input;
  const yf = lookup.year;
  const yearForLookup =
    yf !== null && yf !== undefined && yf !== "" ? String(yf) : "";
  const yi = input.yearIdentified;
  const yearIdentified =
    yi !== null && yi !== undefined && yi !== "" ? String(yi) : "";

  const summary = issueSummary;
  const w = summary?.whatMadeSpecial;

  const issueSummaryJson = summary ? JSON.stringify(summary) : "";

  return [
    input.rowId,
    input.createdAtIso,
    input.createdAtIso,
    "comicinfo",
    "draft",
    "",
    "",
    "",
    "",
    cellString(lookup.title),
    cellString(lookup.issueNumber),
    cellString(lookup.volumeOrSeries),
    cellString(lookup.month),
    yearIdentified,
    yearForLookup,
    summary ? joinPipe(summary.keyFeatures) : "",
    summary ? joinPipe(summary.keyCharacters) : "",
    summary ? summary.stories : "",
    summary?.caveat != null ? String(summary.caveat) : "",
    w?.debutsRevelationsAndDeaths ?? "",
    w?.significantCharacterMoments ?? "",
    w?.overallSignificance ?? "",
    w?.collectorValue ?? "",
    issueSummaryJson,
    summary ? summary.physicalCondition : "",
    summary ? summary.conditionNotes : "",
    summary ? summary.cgcGradeRange : "",
    input.tellMeQuery,
    input.baseQuery,
    "",
    "",
    "",
    "",
    "1",
    "USD",
    "",
    "",
    "",
  ];
}

export async function getSheetsClient() {
  const { credentialsRaw } = sheetsEnv();
  if (!credentialsRaw) {
    throw new Error("GOOGLE_SHEETS_CREDENTIALS is not set.");
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credentialsRaw) as Record<string, unknown>;
  } catch {
    throw new Error("GOOGLE_SHEETS_CREDENTIALS is not valid JSON.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

/** Ensures row 1 contains COMICINFO_SHEET_COLUMNS if A1 is empty. */
async function ensureHeaderRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
) {
  const rangeA1 = `'${tabName.replace(/'/g, "''")}'!A1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1,
  });
  const first = existing.data.values?.[0]?.[0];
  if (first !== undefined && first !== null && String(first).trim() !== "") {
    return;
  }

  const lastColLetter = columnNumberToLetters(COMICINFO_SHEET_COLUMN_COUNT);
  const headerRange = `'${tabName.replace(/'/g, "''")}'!A1:${lastColLetter}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: headerRange,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [Array.from(COMICINFO_SHEET_COLUMNS)],
    },
  });
}

/** 1-based column index → A, B, …, Z, AA, … */
function columnNumberToLetters(oneBasedIndex: number) {
  let n = oneBasedIndex;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function appendComicInfoRowToGoogleSheet(input: {
  lookup: LookupRequest;
  yearIdentified: number | string | null | undefined;
  baseQuery: string;
  tellMeQuery: string;
  issueSummary: IssueSummary | null;
}): Promise<{ rowId: string; rowNumber: number }> {
  const { spreadsheetId, tabName } = sheetsEnv();
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set.");
  }

  const rowId = crypto.randomUUID();
  const createdAtIso = new Date().toISOString();
  const values = buildComicInfoSheetRowValues({
    rowId,
    createdAtIso,
    ...input,
  });

  if (values.length !== COMICINFO_SHEET_COLUMN_COUNT) {
    throw new Error(
      `Sheet row column count mismatch: expected ${COMICINFO_SHEET_COLUMN_COUNT}, got ${values.length}.`,
    );
  }

  const sheets = await getSheetsClient();
  await ensureHeaderRow(sheets, spreadsheetId, tabName);

  const appendRange = `'${tabName.replace(/'/g, "''")}'!A:${columnNumberToLetters(COMICINFO_SHEET_COLUMN_COUNT)}`;
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: appendRange,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });

  const rowNumber =
    parseRowNumberFromUpdatedRange(appendRes.data.updates?.updatedRange ?? null) ?? null;
  if (rowNumber === null || rowNumber < 2) {
    throw new Error("Could not determine appended row number from Google Sheets response.");
  }

  return { rowId, rowNumber };
}

/** Find 1-based sheet row number by `row_id` (column A). */
export async function findComicInfoRowNumberByRowId(rowId: string): Promise<number | null> {
  const id = rowId.trim();
  if (!id) {
    return null;
  }
  const { spreadsheetId, tabName } = sheetsEnv();
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set.");
  }
  const sheets = await getSheetsClient();
  const colA = `'${tabName.replace(/'/g, "''")}'!A:A`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: colA,
  });
  const rows = res.data.values ?? [];
  for (let i = 0; i < rows.length; i += 1) {
    const cell = rows[i]?.[0];
    if (cell != null && String(cell).trim() === id) {
      return i + 1;
    }
  }
  return null;
}

export async function getComicInfoSheetRow(rowNumber: number): Promise<string[] | null> {
  const { spreadsheetId, tabName } = sheetsEnv();
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set.");
  }
  if (rowNumber < 2) {
    return null;
  }
  const sheets = await getSheetsClient();
  const lastCol = columnNumberToLetters(COMICINFO_SHEET_COLUMN_COUNT);
  const range = `'${tabName.replace(/'/g, "''")}'!A${rowNumber}:${lastCol}${rowNumber}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const row = res.data.values?.[0];
  if (!row) {
    return null;
  }
  return normalizeSheetRow(row);
}

export async function updateComicInfoSheetRowPartial(
  rowNumber: number,
  updates: Partial<
    Record<
      | "pipeline_status"
      | "last_error"
      | "ebay_offer_id"
      | "ebay_listing_id"
      | "ebay_sku"
      | "updated_at",
      string
    >
  >,
): Promise<void> {
  const { spreadsheetId, tabName } = sheetsEnv();
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set.");
  }
  if (rowNumber < 2) {
    throw new Error("Invalid sheet row number.");
  }

  const current = await getComicInfoSheetRow(rowNumber);
  if (!current) {
    throw new Error("Sheet row not found.");
  }

  const next = [...current];
  const set = (name: Parameters<typeof comicInfoSheetColumnIndex>[0], value: string) => {
    next[comicInfoSheetColumnIndex(name)] = value;
  };

  if (updates.pipeline_status !== undefined) {
    set("pipeline_status", updates.pipeline_status);
  }
  if (updates.last_error !== undefined) {
    set("last_error", updates.last_error);
  }
  if (updates.ebay_offer_id !== undefined) {
    set("ebay_offer_id", updates.ebay_offer_id);
  }
  if (updates.ebay_listing_id !== undefined) {
    set("ebay_listing_id", updates.ebay_listing_id);
  }
  if (updates.ebay_sku !== undefined) {
    set("ebay_sku", updates.ebay_sku);
  }
  if (updates.updated_at !== undefined) {
    set("updated_at", updates.updated_at);
  }

  const sheets = await getSheetsClient();
  const lastCol = columnNumberToLetters(COMICINFO_SHEET_COLUMN_COUNT);
  const range = `'${tabName.replace(/'/g, "''")}'!A${rowNumber}:${lastCol}${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [next],
    },
  });
}

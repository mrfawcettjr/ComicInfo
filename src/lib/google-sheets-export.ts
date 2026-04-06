import { google } from "googleapis";

import { COMICINFO_SHEET_COLUMNS, COMICINFO_SHEET_COLUMN_COUNT } from "@/lib/sheet-columns";
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

function cellString(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
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
  const { lookup } = input;
  const yf = lookup.year;
  const yearForLookup =
    yf !== null && yf !== undefined && yf !== "" ? String(yf) : "";

  // Minimal debug export: short, high-signal columns only.
  return [
    input.rowId,
    input.createdAtIso,
    cellString(lookup.title),
    cellString(lookup.issueNumber),
    yearForLookup,
    input.baseQuery,
  ];
}

async function getSheetsClient() {
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

/** 1-based column index -> A, B, ..., Z, AA, ... */
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
}): Promise<void> {
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
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: appendRange,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });
}

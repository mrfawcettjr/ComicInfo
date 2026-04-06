/**
 * ComicInfo → Google Sheets debug row layout (minimal columns only).
 * Order must match `buildComicInfoSheetRowValues` in `google-sheets-export.ts`.
 */
export const COMICINFO_SHEET_COLUMNS = [
  "row_id",
  "created_at",
  "comic_title",
  "issue_number",
  "year_for_lookup",
  "base_query",
] as const;

export type ComicInfoSheetColumn = (typeof COMICINFO_SHEET_COLUMNS)[number];

export const COMICINFO_SHEET_COLUMN_COUNT = COMICINFO_SHEET_COLUMNS.length;

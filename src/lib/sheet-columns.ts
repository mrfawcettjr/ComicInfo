/**
 * ComicInfo → Google Sheets row layout (eBay staging).
 * Order must match `buildComicInfoSheetRowValues` in `google-sheets-export.ts`.
 * Row 1 in the tab should be these headers (written automatically on first export if A1 is empty).
 * Missing optional values are written as empty cells ("").
 */
export const COMICINFO_SHEET_COLUMNS = [
  "row_id",
  "created_at",
  "updated_at",
  "source",
  "pipeline_status",
  "last_error",
  "ebay_offer_id",
  "ebay_listing_id",
  "ebay_sku",
  "comic_title",
  "issue_number",
  "volume_or_series",
  "publication_month",
  "year_identified",
  "year_for_lookup",
  "key_features",
  "key_characters",
  "stories",
  "caveat",
  "special_debuts_revelations_deaths",
  "special_character_moments",
  "special_overall_significance",
  "special_collector_value",
  "issue_summary_json",
  "physical_condition",
  "condition_notes",
  "cgc_grade_range",
  "tell_me_query",
  "base_query",
  "ebay_title",
  "ebay_description_plain",
  "ebay_category_id",
  "condition_id",
  "quantity",
  "currency",
  "price",
  "photo_urls",
  "merchant_location_key",
] as const;

export type ComicInfoSheetColumn = (typeof COMICINFO_SHEET_COLUMNS)[number];

export const COMICINFO_SHEET_COLUMN_COUNT = COMICINFO_SHEET_COLUMNS.length;

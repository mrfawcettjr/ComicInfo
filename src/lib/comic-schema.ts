import { z } from "zod";

export const conditionAssessmentSchema = z.object({
  physicalCondition: z
    .string()
    .default("")
    .transform((s) => s.trim()),
  conditionNotes: z
    .string()
    .default("")
    .transform((s) => s.trim()),
  /** e.g. "7.0 to 8.0" */
  cgcGradeRange: z
    .string()
    .default("")
    .transform((s) => s.trim()),
});

/** Identifying metadata extracted from cover images (and optional Comic Vine enrichment). */
export const comicIdentificationSchema = z.object({
  title: z.string().nullable(),
  issueNumber: z.string().nullable(),
  year: z
    .union([z.number(), z.string(), z.null()])
    .transform((value) => {
      if (value === null || value === undefined) {
        return null;
      }
      const parsed =
        typeof value === "number" ? value : Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }),
  month: z.string().nullable(),
  /** Series title, volume label, or "Vol. N" if visible on the cover or indicia. */
  volumeOrSeries: z.string().nullable(),
}).extend(conditionAssessmentSchema.shape);

export type ComicIdentification = z.infer<typeof comicIdentificationSchema>;
export type ConditionAssessment = z.infer<typeof conditionAssessmentSchema>;

export const lookupRequestSchema = z.object({
  title: z.string().nullable().optional(),
  issueNumber: z.string().nullable().optional(),
  year: z.union([z.number(), z.string()]).nullable().optional(),
  month: z.string().nullable().optional(),
  volumeOrSeries: z.string().nullable().optional(),
  /** Year from cover analysis before user override; used for Google Sheets export. */
  yearIdentified: z.union([z.number(), z.string()]).nullable().optional(),
  /** Photo-derived condition estimate from /api/analyze (optional). */
  photoConditionAssessment: conditionAssessmentSchema.optional(),
});

export type LookupRequest = z.infer<typeof lookupRequestSchema>;

/** Gemini summary of Brave snippets, scoped to one identified issue. */
export const issueSummarySchema = z.object({
  keyFeatures: z.array(z.string()),
  stories: z.string(),
  caveat: z.string().nullable().optional(),
  /** Up to 10 named characters appearing in this issue (from snippets only). */
  keyCharacters: z
    .array(z.string())
    .default([])
    .transform((names) => names.slice(0, 10)),
  /** Collector-focused angles derived from snippets only. */
  whatMadeSpecial: z.object({
    /** Debuts, deaths, surprise revelations, key origin beats for this issue. */
    debutsRevelationsAndDeaths: z
      .string()
      .default("")
      .transform((s) => s.trim()),
    /** Pivotal scenes or beats for characters in this issue. */
    significantCharacterMoments: z
      .string()
      .default("")
      .transform((s) => s.trim()),
    /** Why this issue matters in the run or mythos (snippets only). */
    overallSignificance: z
      .string()
      .default("")
      .transform((s) => s.trim()),
    /** Rarity, keys, demand, or listing angles for collectors (no invented prices). */
    collectorValue: z
      .string()
      .default("")
      .transform((s) => s.trim()),
  }),
  /**
   * CGC-style labels from web snippets only (same Gemini call as the rest of the summary).
   * Empty when snippets do not support condition or grade.
   */
  physicalCondition: conditionAssessmentSchema.shape.physicalCondition,
  conditionNotes: conditionAssessmentSchema.shape.conditionNotes,
  /** e.g. "7.0 to 8.0" — estimate from photos + snippet evidence. */
  cgcGradeRange: conditionAssessmentSchema.shape.cgcGradeRange,
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;

export type WhatMadeSpecialSection = IssueSummary["whatMadeSpecial"];

/** Manual Google Sheets row append (same columns as `buildComicInfoSheetRowValues`). */
export const sheetExportRequestSchema = lookupRequestSchema.extend({
  baseQuery: z.string().min(1),
  tellMeQuery: z.string().min(1),
  issueSummary: issueSummarySchema.nullable(),
});

export type SheetExportRequest = z.infer<typeof sheetExportRequestSchema>;

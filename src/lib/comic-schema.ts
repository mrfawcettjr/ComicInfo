import { z } from "zod";

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
});

export type ComicIdentification = z.infer<typeof comicIdentificationSchema>;

export const lookupRequestSchema = z.object({
  title: z.string().nullable().optional(),
  issueNumber: z.string().nullable().optional(),
  year: z.union([z.number(), z.string()]).nullable().optional(),
  month: z.string().nullable().optional(),
  volumeOrSeries: z.string().nullable().optional(),
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
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;

export type WhatMadeSpecialSection = IssueSummary["whatMadeSpecial"];

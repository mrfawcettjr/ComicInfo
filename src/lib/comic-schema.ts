import { z } from "zod";

export const comicInfoSchema = z.object({
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
  keyCharacters: z.array(z.string()),
  keyEvents: z.array(z.string()),
  /** Rough CGC-style estimate from visible condition only; not an official grade. */
  approximateCgcGrade: z.string().nullable(),
  confidenceNotes: z.string().nullable().optional(),
});

export type ComicInfo = z.infer<typeof comicInfoSchema>;

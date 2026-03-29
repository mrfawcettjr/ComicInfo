import { z } from "zod";

export const comicInfoSchema = z.object({
  title: z.string().nullable(),
  issueNumber: z.string().nullable(),
  year: z.number().int().nullable(),
  month: z.string().nullable(),
  keyCharacters: z.array(z.string()),
  keyEvents: z.array(z.string()),
  confidenceNotes: z.string().nullable().optional(),
});

export type ComicInfo = z.infer<typeof comicInfoSchema>;

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ComicIdentification,
  IssueSummary,
  WhatMadeSpecialSection,
} from "@/lib/comic-schema";
import { compressImageForUpload } from "@/lib/compress-image";

const MAX_IMAGES = 4;

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tif|tiff)$/.test(lower);
}

function formatAnalyzeFailureMessage(
  body: { error?: string; details?: string },
  httpStatus: number,
): string {
  const summary = body.error?.trim();
  const details = body.details?.trim();

  if (details && summary && details !== summary) {
    return `${summary}\n\n${details}`;
  }
  if (details) {
    return details;
  }
  if (summary) {
    return summary;
  }
  return `Analysis failed (HTTP ${httpStatus}).`;
}

function preventDragDefaults(event: React.DragEvent) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

function displayValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

function emptyWhatMadeSpecial(): WhatMadeSpecialSection {
  return {
    debutsRevelationsAndDeaths: "",
    significantCharacterMoments: "",
    overallSignificance: "",
    collectorValue: "",
  };
}

function normalizeWhatMadeSpecial(raw: unknown): WhatMadeSpecialSection {
  if (typeof raw === "string") {
    return { ...emptyWhatMadeSpecial(), debutsRevelationsAndDeaths: raw.trim() };
  }
  if (!raw || typeof raw !== "object") {
    return emptyWhatMadeSpecial();
  }
  const o = raw as Record<string, unknown>;
  const pick = (key: keyof WhatMadeSpecialSection) =>
    typeof o[key] === "string" ? (o[key] as string).trim() : "";
  return {
    debutsRevelationsAndDeaths: pick("debutsRevelationsAndDeaths"),
    significantCharacterMoments: pick("significantCharacterMoments"),
    overallSignificance: pick("overallSignificance"),
    collectorValue: pick("collectorValue"),
  };
}

function isWhatMadeSpecialEmpty(section: WhatMadeSpecialSection) {
  return (
    !section.debutsRevelationsAndDeaths.trim() &&
    !section.significantCharacterMoments.trim() &&
    !section.overallSignificance.trim() &&
    !section.collectorValue.trim()
  );
}

/** Empty field uses the identified year; non-empty must be a plausible publication year. */
function parseYearForLookup(
  draft: string,
  identifiedYear: number | null,
): { ok: true; year: number | null } | { ok: false; message: string } {
  const t = draft.trim();
  if (t === "") {
    return { ok: true, year: identifiedYear };
  }
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1800 || n > 2100) {
    return {
      ok: false,
      message:
        "Year must be a number between 1800 and 2100, or leave the field empty to use the year from identification.",
    };
  }
  return { ok: true, year: n };
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Analyzing…");
  const [result, setResult] = useState<ComicIdentification | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBaseQuery, setLookupBaseQuery] = useState<string | null>(null);
  const [lookupIssueSummary, setLookupIssueSummary] = useState<IssueSummary | null>(
    null,
  );
  const [lookupSummaryError, setLookupSummaryError] = useState<string | null>(
    null,
  );
  const [lookupTellMeQuery, setLookupTellMeQuery] = useState<string | null>(null);
  const [googleSheetsExportAvailable, setGoogleSheetsExportAvailable] =
    useState(false);
  const [sheetExportLoading, setSheetExportLoading] = useState(false);
  const [sheetExportFeedback, setSheetExportFeedback] = useState<
    { kind: "success" } | { kind: "error"; message: string } | null
  >(null);
  /** Editable year before lookup; synced from `result` when analysis completes. */
  const [yearDraft, setYearDraft] = useState("");

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  useEffect(() => {
    if (result) {
      setYearDraft(result.year != null ? String(result.year) : "");
    } else {
      setYearDraft("");
    }
  }, [result]);

  function mergeFiles(incoming: File[]) {
    const imageFiles = incoming.filter((file) => isImageFile(file));
    if (imageFiles.length === 0) {
      setError("Please drop image files only.");
      return;
    }

    setFiles((previous) => {
      const merged = [...previous, ...imageFiles].slice(0, MAX_IMAGES);
      if (previous.length + imageFiles.length > MAX_IMAGES) {
        setError(`Only ${MAX_IMAGES} images are allowed. Extra files were ignored.`);
      } else {
        setError(null);
      }
      return merged;
    });
  }

  function resetLookupState() {
    setConfirmed(false);
    setLookupError(null);
    setLookupBaseQuery(null);
    setLookupTellMeQuery(null);
    setGoogleSheetsExportAvailable(false);
    setSheetExportFeedback(null);
    setLookupIssueSummary(null);
    setLookupSummaryError(null);
  }

  async function analyze() {
    if (files.length === 0) {
      setError("Please add at least one image.");
      return;
    }

    setLoading(true);
    setLoadingMessage("Compressing images…");
    setError(null);
    setResult(null);
    resetLookupState();

    try {
      const compressedFiles = await Promise.all(
        files.map((file) => compressImageForUpload(file)),
      );

      const formData = new FormData();
      for (const file of compressedFiles) {
        formData.append("images", file);
      }

      setLoadingMessage("Uploading and analyzing…");

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(
          response.ok
            ? "The server returned a response that was not valid JSON."
            : `Request failed (${response.status}). The server response was not valid JSON.`,
        );
      }

      const body = payload as {
        data?: ComicIdentification;
        error?: string;
        details?: string;
      };

      if (!response.ok || !body.data) {
        throw new Error(formatAnalyzeFailureMessage(body, response.status));
      }

      setResult(body.data);
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : "Analysis failed.");
    } finally {
      setLoading(false);
      setLoadingMessage("Analyzing…");
    }
  }

  async function confirmAndLookup() {
    if (!result) {
      return;
    }

    const yearParsed = parseYearForLookup(yearDraft, result.year);
    if (!yearParsed.ok) {
      setLookupError(yearParsed.message);
      return;
    }

    setLookupLoading(true);
    setLookupError(null);
    setLookupIssueSummary(null);
    setLookupSummaryError(null);
    setLookupBaseQuery(null);
    setLookupTellMeQuery(null);
    setGoogleSheetsExportAvailable(false);
    setSheetExportFeedback(null);

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          issueNumber: result.issueNumber,
          year: yearParsed.year,
          month: result.month,
          volumeOrSeries: result.volumeOrSeries,
          yearIdentified: result.year,
        }),
      });

      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(
          response.ok
            ? "Invalid response from lookup service."
            : `Lookup failed (${response.status}).`,
        );
      }

      const body = payload as {
        baseQuery?: string;
        tellMeQuery?: string;
        issueSummary?: IssueSummary | null;
        summaryError?: string;
        googleSheetsExportAvailable?: boolean;
        error?: string;
        details?: string;
      };

      if (!response.ok) {
        throw new Error(
          body.details ?? body.error ?? `Lookup failed (${response.status}).`,
        );
      }

      setConfirmed(true);
      setLookupBaseQuery(
        typeof body.baseQuery === "string" ? body.baseQuery : null,
      );
      setLookupTellMeQuery(
        typeof body.tellMeQuery === "string" ? body.tellMeQuery : null,
      );
      setGoogleSheetsExportAvailable(
        body.googleSheetsExportAvailable === true,
      );
      setSheetExportFeedback(null);
      setLookupSummaryError(
        typeof body.summaryError === "string" ? body.summaryError : null,
      );
      if (
        body.issueSummary &&
        typeof body.issueSummary === "object" &&
        Array.isArray(body.issueSummary.keyFeatures) &&
        typeof body.issueSummary.stories === "string"
      ) {
        const rawChars = body.issueSummary.keyCharacters;
        const keyCharacters = Array.isArray(rawChars)
          ? rawChars
              .filter((n): n is string => typeof n === "string")
              .slice(0, 10)
          : [];
        setLookupIssueSummary({
          keyFeatures: body.issueSummary.keyFeatures,
          stories: body.issueSummary.stories,
          caveat: body.issueSummary.caveat ?? null,
          keyCharacters,
          whatMadeSpecial: normalizeWhatMadeSpecial(body.issueSummary.whatMadeSpecial),
        });
      } else {
        setLookupIssueSummary(null);
      }
    } catch (lookupErr) {
      setLookupError(
        lookupErr instanceof Error ? lookupErr.message : "Lookup failed.",
      );
    } finally {
      setLookupLoading(false);
    }
  }

  async function sendToGoogleSheet() {
    if (!result || lookupBaseQuery === null || lookupTellMeQuery === null) {
      return;
    }

    const yearParsed = parseYearForLookup(yearDraft, result.year);
    if (!yearParsed.ok) {
      setSheetExportFeedback({ kind: "error", message: yearParsed.message });
      return;
    }

    setSheetExportLoading(true);
    setSheetExportFeedback(null);

    try {
      const response = await fetch("/api/sheet-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          issueNumber: result.issueNumber,
          year: yearParsed.year,
          month: result.month,
          volumeOrSeries: result.volumeOrSeries,
          yearIdentified: result.year,
          baseQuery: lookupBaseQuery,
          tellMeQuery: lookupTellMeQuery,
          issueSummary: lookupIssueSummary,
        }),
      });

      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(
          response.ok
            ? "Invalid response from sheet export."
            : `Sheet export failed (${response.status}).`,
        );
      }

      const errBody = data as { error?: string; ok?: boolean };
      if (!response.ok) {
        throw new Error(
          errBody.error ?? `Sheet export failed (${response.status}).`,
        );
      }

      setSheetExportFeedback({ kind: "success" });
    } catch (exportErr) {
      setSheetExportFeedback({
        kind: "error",
        message:
          exportErr instanceof Error ? exportErr.message : "Sheet export failed.",
      });
    } finally {
      setSheetExportLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">ComicInfo</h1>
        <p className="text-zinc-600 dark:text-zinc-300">
          Upload photos of a comic cover. We identify the title, issue, publication month/year,
          and series or volume when visible. Confirm the details, then we ask the web “Tell me
          about …” that comic.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Images are compressed in your browser (≤ 1 MB each) before upload. Identification uses
          Google Gemini. After you confirm, we search with Brave, then Gemini summarizes key
          features, key characters (up to 10), “what made this issue special,” and stories for that
          issue only (Brave: JSON API,
          not HTML scraping). Do not upload sensitive images.
        </p>
      </section>

      <section
        className="flex min-h-[220px] flex-col gap-4 rounded-xl border-2 border-dashed border-zinc-300 p-6 transition hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
        onDragEnter={preventDragDefaults}
        onDragOver={preventDragDefaults}
        onDrop={(event) => {
          event.preventDefault();
          mergeFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            Drop images anywhere in this box, or choose files. Supported: JPG, PNG, WEBP, HEIC.
          </p>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files ? Array.from(event.target.files) : [];
                mergeFiles(selected);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose files
            </button>
          </div>
        </div>

        {previews.length > 0 && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {previews.map((preview, index) => (
              <div
                key={`${preview.file.name}-${preview.file.size}-${index}`}
                className="space-y-2 rounded border p-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.url}
                  alt={preview.file.name}
                  className="h-32 w-full rounded object-cover"
                  draggable={false}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs">{preview.file.name}</p>
                  <button
                    type="button"
                    className="cursor-pointer rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
                    onClick={() => {
                      setFiles((previous) =>
                        previous.filter((_, itemIndex) => itemIndex !== index),
                      );
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={analyze}
          disabled={loading || files.length === 0}
          className="cursor-pointer rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {loading ? loadingMessage : "Analyze"}
        </button>
        {files.length > 0 && (
          <button
            type="button"
            className="cursor-pointer rounded border px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
            onClick={() => {
              setFiles([]);
              setResult(null);
              setError(null);
              resetLookupState();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 break-words whitespace-pre-wrap dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          role="alert"
        >
          {error}
        </div>
      )}

      {result && (
        <section className="space-y-4 rounded-xl border p-4">
          <h2 className="text-xl font-semibold">Identified comic</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Review the fields below. If they look right, confirm to search the web with “Tell me
            about …” for this comic. You can fix the year if identification got it wrong — that
            value is used for the Brave search and summary.
          </p>
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="font-medium text-zinc-950 dark:text-zinc-50">Name / title</dt>
              <dd className="mt-1">{displayValue(result.title)}</dd>
            </div>
            <div>
              <dt className="font-medium text-zinc-950 dark:text-zinc-50">Issue number</dt>
              <dd className="mt-1">{displayValue(result.issueNumber)}</dd>
            </div>
            <div>
              <dt className="font-medium text-zinc-950 dark:text-zinc-50">Year</dt>
              <dd className="mt-1">
                <label htmlFor="year-override" className="sr-only">
                  Year (editable — used for lookup)
                </label>
                <input
                  id="year-override"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={lookupLoading}
                  value={yearDraft}
                  onChange={(event) => setYearDraft(event.target.value)}
                  placeholder={result.year != null ? String(result.year) : "e.g. 1985"}
                  className="w-full max-w-[12rem] rounded border border-zinc-300 bg-white px-2 py-1.5 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
                />
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Detected: {displayValue(result.year)}. Leave blank to keep that value, or type
                  1800–2100 to override for the lookup only.
                </p>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-zinc-950 dark:text-zinc-50">Month</dt>
              <dd className="mt-1">{displayValue(result.month)}</dd>
            </div>
            <div className="md:col-span-2">
              <dt className="font-medium text-zinc-950 dark:text-zinc-50">
                Volume / series
              </dt>
              <dd className="mt-1">{displayValue(result.volumeOrSeries)}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              onClick={confirmAndLookup}
              disabled={lookupLoading}
              className="cursor-pointer rounded bg-emerald-700 px-4 py-2 text-sm text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              {lookupLoading
                ? "Looking up & summarizing…"
                : "Yes, this is correct — tell me about this comic"}
            </button>
          </div>

          {lookupError && (
            <div
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              role="status"
            >
              {lookupError}
            </div>
          )}

          {confirmed &&
            !lookupError &&
            lookupBaseQuery !== null &&
            lookupTellMeQuery !== null &&
            googleSheetsExportAvailable && (
              <div className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Google Sheet
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Append this lookup as one row to your ComicInfo staging sheet (same columns as
                  the export script).
                </p>
                <button
                  type="button"
                  onClick={sendToGoogleSheet}
                  disabled={sheetExportLoading}
                  className="cursor-pointer rounded border border-zinc-400 bg-white px-4 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-500 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                >
                  {sheetExportLoading ? "Adding row…" : "Add row to Google Sheet"}
                </button>
                {sheetExportFeedback?.kind === "success" ? (
                  <p
                    className="text-sm text-emerald-800 dark:text-emerald-300"
                    role="status"
                  >
                    Row added to your spreadsheet.
                  </p>
                ) : null}
                {sheetExportFeedback?.kind === "error" ? (
                  <p
                    className="text-sm text-amber-800 dark:text-amber-200"
                    role="status"
                  >
                    {sheetExportFeedback.message}
                  </p>
                ) : null}
              </div>
            )}

          {confirmed && !lookupError && lookupBaseQuery !== null && (
            <div className="space-y-6 border-t pt-4 dark:border-zinc-700">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Issue you identified:{" "}
                <span className="font-mono text-zinc-700 dark:text-zinc-300">
                  {lookupBaseQuery}
                </span>
              </p>

              {lookupSummaryError ? (
                <div
                  className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  role="status"
                >
                  {lookupSummaryError}
                </div>
              ) : null}

              {lookupIssueSummary ? (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">This issue</h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Key features, characters, collector moments, and stories for this issue only
                    (other issues and series are filtered out when possible).
                  </p>
                  {lookupIssueSummary.keyCharacters.length > 0 ? (
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Key characters
                      </h4>
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {lookupIssueSummary.keyCharacters.map((name, i) => (
                          <li
                            key={`${name}-${i}`}
                            className="rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1 text-sm text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-200"
                          >
                            {name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {!isWhatMadeSpecialEmpty(lookupIssueSummary.whatMadeSpecial) ? (
                    <div className="space-y-4">
                      <div>
                        <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          What made this issue special
                        </h4>
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          From web snippets for this issue only — not investment advice.
                        </p>
                      </div>
                      {lookupIssueSummary.whatMadeSpecial.debutsRevelationsAndDeaths.trim() ? (
                        <div>
                          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                            First appearances, deaths & revelations
                          </h5>
                          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                            {lookupIssueSummary.whatMadeSpecial.debutsRevelationsAndDeaths}
                          </div>
                        </div>
                      ) : null}
                      {lookupIssueSummary.whatMadeSpecial.significantCharacterMoments.trim() ? (
                        <div>
                          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                            Significant character moments
                          </h5>
                          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                            {lookupIssueSummary.whatMadeSpecial.significantCharacterMoments}
                          </div>
                        </div>
                      ) : null}
                      {lookupIssueSummary.whatMadeSpecial.overallSignificance.trim() ? (
                        <div>
                          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                            Overall significance
                          </h5>
                          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                            {lookupIssueSummary.whatMadeSpecial.overallSignificance}
                          </div>
                        </div>
                      ) : null}
                      {lookupIssueSummary.whatMadeSpecial.collectorValue.trim() ? (
                        <div>
                          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                            Collector appeal
                          </h5>
                          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                            {lookupIssueSummary.whatMadeSpecial.collectorValue}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {lookupIssueSummary.keyFeatures.length > 0 ? (
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Key features
                      </h4>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-800 dark:text-zinc-200">
                        {lookupIssueSummary.keyFeatures.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {lookupIssueSummary.stories.trim() ? (
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Stories
                      </h4>
                      <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                        {lookupIssueSummary.stories}
                      </div>
                    </div>
                  ) : null}
                  {lookupIssueSummary.caveat?.trim() ? (
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      Note: {lookupIssueSummary.caveat}
                    </p>
                  ) : null}
                  {lookupIssueSummary.keyFeatures.length === 0 &&
                  lookupIssueSummary.keyCharacters.length === 0 &&
                  isWhatMadeSpecialEmpty(lookupIssueSummary.whatMadeSpecial) &&
                  !lookupIssueSummary.stories.trim() &&
                  !lookupIssueSummary.caveat?.trim() ? (
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      No summary lines were returned for this issue. Try a clearer cover photo or
                      analyze again.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

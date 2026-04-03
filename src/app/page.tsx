"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ComicIdentification } from "@/lib/comic-schema";
import { compressImageForUpload } from "@/lib/compress-image";

const MAX_IMAGES = 4;

type SearchHit = {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
};

type LookupSection = {
  label: string;
  query: string;
  items: SearchHit[];
};

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
  const [lookupSections, setLookupSections] = useState<LookupSection[]>([]);

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

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
    setLookupSections([]);
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

    setLookupLoading(true);
    setLookupError(null);
    setLookupSections([]);
    setLookupBaseQuery(null);

    try {
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          issueNumber: result.issueNumber,
          year: result.year,
          month: result.month,
          volumeOrSeries: result.volumeOrSeries,
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
        sections?: LookupSection[];
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
      setLookupSections(Array.isArray(body.sections) ? body.sections : []);
    } catch (lookupErr) {
      setLookupError(
        lookupErr instanceof Error ? lookupErr.message : "Lookup failed.",
      );
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">ComicInfo</h1>
        <p className="text-zinc-600 dark:text-zinc-300">
          Upload photos of a comic cover. We identify the title, issue, publication month/year,
          and series or volume when visible. Confirm the details, then search the web for
          related results.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Images are compressed in your browser (≤ 1 MB each) before upload. Identification uses
          Google Gemini. After you confirm, plot and character summaries use the Brave Search API
          (JSON, not HTML scraping). Do not upload sensitive images.
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
            Review the fields below. If they look right, confirm to fetch plot and character
          information from the web.
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
              <dd className="mt-1">{displayValue(result.year)}</dd>
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
                ? "Searching…"
                : "Yes, this is correct — look up plot & characters"}
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

          {confirmed && !lookupError && lookupBaseQuery !== null && (
            <div className="space-y-6 border-t pt-4 dark:border-zinc-700">
              <div>
                <h3 className="text-lg font-semibold">What people say online</h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Based on identified title and issue:{" "}
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">
                    {lookupBaseQuery}
                  </span>
                </p>
              </div>

              {lookupSections.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  No sections returned. Try again or use different cover photos.
                </p>
              ) : (
                lookupSections.map((section) => (
                  <div key={section.label} className="space-y-3">
                    <div>
                      <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                        {section.label}
                      </h4>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Search:{" "}
                        <span className="font-mono text-zinc-700 dark:text-zinc-300">
                          {section.query}
                        </span>
                      </p>
                    </div>
                    {!section.items || section.items.length === 0 ? (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        No results for this angle. The issue may be obscure or newly published.
                      </p>
                    ) : (
                      <ul className="space-y-4">
                        {section.items.map((hit, hitIndex) => (
                          <li
                            key={`${section.label}-${hitIndex}-${hit.link}`}
                            className="rounded border border-zinc-200 p-3 dark:border-zinc-700"
                          >
                            <a
                              href={hit.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block font-medium text-blue-700 hover:underline dark:text-blue-400"
                            >
                              {hit.title || hit.link}
                            </a>
                            {hit.displayLink ? (
                              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                {hit.displayLink}
                              </p>
                            ) : null}
                            {hit.snippet ? (
                              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
                                {hit.snippet}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

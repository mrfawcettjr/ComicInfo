# ComicInfo

ComicInfo is a Next.js web app that analyzes up to four comic cover photos and returns:

- Comic **title** (name)
- **Issue number**
- **Year** and **month** of publication (when visible)
- **Volume or series** label (when visible)

After you confirm the identification, the app runs a **Google Programmable Search** web search and displays result titles, links, and snippets.

It is designed to run locally on a MacBook Pro and deploy to Vercel.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- **Google Gemini** (multimodal vision) — `POST /api/analyze`
- Optional **Comic Vine** — enriches `year` and `volumeOrSeries` when a matching issue is found
- **Google Custom Search JSON API** — `POST /api/lookup` (after user confirmation; not HTML scraping)

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy env vars:

   ```bash
   cp .env.example .env.local
   ```

3. Set your keys in `.env.local`:

   - `GEMINI_API_KEY` — required ([Google AI Studio](https://aistudio.google.com/apikey)).
   - `GEMINI_MODEL` — optional (default `gemini-2.5-flash`).
   - `GOOGLE_GENERATIVE_AI_API_KEY` — optional alias for `GEMINI_API_KEY`.
   - `COMIC_VINE_API_KEY` — optional; helps year / series when Gemini omits them.
   - `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID` — required for the confirmation search. Create a [Programmable Search Engine](https://programmablesearchengine.google.com/) and enable the Custom Search JSON API in Google Cloud.

4. Start dev server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Add up to four comic photos (client compresses to ≤ 1 MB each).
2. Click **Analyze** to extract identification fields.
3. Click **Yes, this is correct — search the web** to fetch Google search results for that metadata.

## API

### `POST /api/analyze`

- Body: `multipart/form-data` with `images` (1–4 files).
- Returns: `{ data: { title, issueNumber, year, month, volumeOrSeries } }`

### `POST /api/lookup`

- Body: JSON `{ title?, issueNumber?, year?, month?, volumeOrSeries? }`
- Returns: `{ query, totalResults, items: [{ title, link, snippet, displayLink }] }`

## Deploy to Vercel

1. Push to [https://github.com/mrfawcettjr/ComicInfo](https://github.com/mrfawcettjr/ComicInfo).
2. Import the repo in Vercel.
3. Set environment variables in the Vercel project:
   - `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
   - `GEMINI_MODEL` (optional)
   - `COMIC_VINE_API_KEY` (optional)
   - `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID` (for search after confirmation)

## Notes

- Uploaded images are sent to Google’s Gemini API for identification.
- **Web search** uses Google’s official Custom Search API — not scraping `google.com` HTML (which is unreliable and often blocked).
- Comic Vine enrichment depends on title/issue matching; ambiguous titles may not match.

# ComicInfo

ComicInfo is a Next.js web app that analyzes up to four comic cover photos and returns:

- Comic **title** (name)
- **Issue number**
- **Year** and **month** of publication (when visible)
- **Volume or series** label (when visible)

After you confirm the identification, the app uses the **Brave Search API** with a **“Tell me about …”** query, then **Google Gemini** summarizes **key features, up to 10 key characters, what made the issue special** (debuts/deaths/revelations, character moments, overall significance, collector appeal), **and stories for that issue only** (filtering other issues when possible). Brave snippets are not shown in the UI; they are used only on the server to build the summary.

It is designed to run locally on a MacBook Pro and deploy to Vercel.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- **Google Gemini** (multimodal vision) — `POST /api/analyze`
- Optional **Comic Vine** — enriches `year` and `volumeOrSeries` when a matching issue is found
- **Brave Search API** — `POST /api/lookup` (after user confirmation; JSON API, not HTML scraping)

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
   - `ComicInfo_Brave_Search` (or `BRAVE_SEARCH_API_KEY`) — required for post-confirmation “Tell me about …” search. Get a key from the [Brave Search API](https://api-dashboard.search.brave.com/).

4. Start dev server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Add up to four comic photos (client compresses to ≤ 1 MB each).
2. Click **Analyze** to extract identification fields.
3. Click **Yes, this is correct — tell me about this comic** to run Brave search for that metadata.

## API

### `POST /api/analyze`

- Body: `multipart/form-data` with `images` (1–4 files).
- Returns: `{ data: { title, issueNumber, year, month, volumeOrSeries } }`

### `POST /api/lookup`

- Body: JSON `{ title?, issueNumber?, year?, month?, volumeOrSeries?, yearIdentified? }` — `yearIdentified` is the analyzed year before user override (used for the Google Sheet `year_identified` column).
- Returns: `{ baseQuery, tellMeQuery, items, issueSummary?, summaryError?, sheetExport }` — Brave + Gemini; `sheetExport` is `{ appended: true }`, `{ appended: false, error }` on append failure, or `{ appended: false, skipped: true }` when Sheets env is not configured.

### Google Sheets (optional)

After a successful lookup, ComicInfo can **append one row** to a spreadsheet for eBay staging. Column names and order are defined in `src/lib/sheet-columns.ts` (row 1 is written automatically on first export if cell `A1` is empty).

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Sheets API** for your project.
2. Create a **service account**, add a JSON key, and copy the entire JSON.
3. Create a spreadsheet (e.g. `ComicInfo_eBay`) and **Share** it with the service account email (`…@….iam.gserviceaccount.com`) as **Editor**.
4. Set `GOOGLE_SHEETS_SPREADSHEET_ID` (from the spreadsheet URL) and `GOOGLE_SHEETS_CREDENTIALS` (JSON string) in `.env.local` / Vercel. Optionally set `GOOGLE_SHEETS_TAB_NAME` if not using `Sheet1`.

## Deploy to Vercel

1. Push to [https://github.com/mrfawcettjr/ComicInfo](https://github.com/mrfawcettjr/ComicInfo).
2. Import the repo in Vercel.
3. Set environment variables in the Vercel project:
   - `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
   - `GEMINI_MODEL` (optional)
   - `COMIC_VINE_API_KEY` (optional)
   - `ComicInfo_Brave_Search` or `BRAVE_SEARCH_API_KEY` (for “Tell me about …” search after confirmation)
   - `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_CREDENTIALS` (optional; appends staging rows after lookup)

## Notes

- Uploaded images are sent to Google’s Gemini API for identification.
- **Web search** uses Brave’s Search API — not scraping search HTML.
- Comic Vine enrichment depends on title/issue matching; ambiguous titles may not match.

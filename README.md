# ComicInfo

ComicInfo is a Next.js web app that analyzes up to four comic cover photos and returns:

- Comic **title** (name)
- **Issue number**
- **Year** and **month** of publication (when visible)
- **Volume or series** label (when visible)

After you confirm the identification, the app uses the **Brave Search API** to fetch web results focused on **plot & story** and **characters**, and displays titles, links, and snippets.

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
   - `ComicInfo_Brave_Search` (or `BRAVE_SEARCH_API_KEY`) — required for post-confirmation plot/character search. Get a key from the [Brave Search API](https://api-dashboard.search.brave.com/).

4. Start dev server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Add up to four comic photos (client compresses to ≤ 1 MB each).
2. Click **Analyze** to extract identification fields.
3. Click **Yes, this is correct — look up plot & characters** to fetch Brave search results for that metadata.

## API

### `POST /api/analyze`

- Body: `multipart/form-data` with `images` (1–4 files).
- Returns: `{ data: { title, issueNumber, year, month, volumeOrSeries } }`

### `POST /api/lookup`

- Body: JSON `{ title?, issueNumber?, year?, month?, volumeOrSeries? }`
- Returns: `{ baseQuery, sections: [{ label, query, items: [{ title, link, snippet, displayLink }] }] }` — two sections (plot & story, characters) from parallel Brave web searches.

## Deploy to Vercel

1. Push to [https://github.com/mrfawcettjr/ComicInfo](https://github.com/mrfawcettjr/ComicInfo).
2. Import the repo in Vercel.
3. Set environment variables in the Vercel project:
   - `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
   - `GEMINI_MODEL` (optional)
   - `COMIC_VINE_API_KEY` (optional)
   - `ComicInfo_Brave_Search` or `BRAVE_SEARCH_API_KEY` (for plot/character search after confirmation)

## Notes

- Uploaded images are sent to Google’s Gemini API for identification.
- **Web search** uses Brave’s Search API — not scraping search HTML.
- Comic Vine enrichment depends on title/issue matching; ambiguous titles may not match.

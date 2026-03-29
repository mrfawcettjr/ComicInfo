# ComicInfo

ComicInfo is a Next.js web app that analyzes up to four comic book photos and returns:

- Title
- Issue number
- Publication year and month
- Key characters
- Key events

It is designed to run locally on a MacBook Pro and deploy to Vercel.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- OpenAI vision model via server route (`/api/analyze`)
- `sharp` for image normalization (including HEIC fallback conversion)

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy env vars:

   ```bash
   cp .env.example .env.local
   ```

3. Set your API key in `.env.local`:

   - `OPENAI_API_KEY` is required.
   - `OPENAI_MODEL` is optional (default is `gpt-4.1`).

4. Start dev server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Drag and drop up to four comic photos from Photos or Finder, or use the file picker.
2. Click **Analyze**.
3. Review extracted metadata and raw JSON output.

## API contract

- Endpoint: `POST /api/analyze`
- Body: `multipart/form-data` with `images` fields (1-4 image files)
- Returns: JSON with `data` object:
  - `title`
  - `issueNumber`
  - `year`
  - `month`
  - `keyCharacters`
  - `keyEvents`
  - `confidenceNotes`

## Deploy to Vercel

1. Push this project to [https://github.com/mrfawcettjr/ComicInfo](https://github.com/mrfawcettjr/ComicInfo).
2. In Vercel, click **Add New Project** and import the `ComicInfo` repo.
3. Set environment variables in Vercel project settings:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (optional)
4. Deploy. Vercel will build and publish on every push to `main`.

## Notes

- Uploaded images are sent to your configured AI provider for analysis.
- Results are assistive and may be incomplete when image text is obscured or unreadable.

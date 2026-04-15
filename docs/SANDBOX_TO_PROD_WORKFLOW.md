# Sandbox → production workflow (ComicInfo)

This project can use **one Git repository** with **separate deploy targets** so sandbox experiments do not affect production until you promote them intentionally.

## Goals

- Validate every change against **eBay Sandbox** first.
- Deploy **production** only from a stable branch, with different env vars and (recommended) a separate Google Sheet tab.
- Keep a clear audit trail of what shipped when.

## Branch model

| Branch | Role |
|--------|------|
| `main` | Integration branch; deploy to **sandbox** (testing). |
| `release/prod` | Release branch; deploy to **production** (live listings). |
| `feature/<short-name>` | Optional short-lived branches off `main` for larger changes. |

**Rule:** Production must **not** auto-deploy from `main`. Point the production Vercel project only at `release/prod` (or use manual production deploys).

## Environment separation

- **Vercel**
  - Sandbox project: production branch = `main` (or preview from feature branches).
  - Production project: production branch = `release/prod`.
- **Secrets**
  - Sandbox: `EBAY_SANDBOX_*`, sandbox OAuth, sandbox business policies.
  - Production: production eBay keys/tokens/policies (different names/prefixes in `.env`).
- **Google Sheets**
  - Recommended: separate tabs or spreadsheets for sandbox vs production staging rows so test listings never touch live inventory data.

## Feature flow

1. Create a branch from `main` (optional but tidy for big changes):

   ```bash
   git checkout main && git pull origin main
   git checkout -b feature/<short-name>
   ```

2. Implement, run locally:

   ```bash
   npm run build
   ```

3. Merge to `main`, push — sandbox deploy updates.

4. Run the **Sandbox validation checklist** (below).

5. When satisfied, **promote** to `release/prod` (see `SOLO_RELEASE_CHEATSHEET.md`).

## Sandbox validation checklist (gate before production)

Use this after a sandbox deploy from `main`:

- [ ] Analyze flow: images → identification → lookup.
- [ ] “Add row to Google Sheet” succeeds.
- [ ] eBay sandbox listing succeeds (JSON or UI path you use).
- [ ] Listing images: allow **several minutes** in sandbox for derivatives; thumbnails may appear before main viewer catches up.
- [ ] Sheet row updated: `ebay_offer_id`, `ebay_listing_id`, `ebay_sku`, `pipeline_status`.
- [ ] After listing, `photo_urls` contains EPS URLs (pipe-separated) when that feature is enabled.
- [ ] Error path: invalid row / missing field returns a clear error and does not corrupt unrelated rows.

## Production release checklist

- [ ] `release/prod` contains only the commits you intend (compare to `main` or review log).
- [ ] Production Vercel env vars point at **production** eBay + correct sheet.
- [ ] Smoke test: one low-risk listing (or dry-run if you add one later).
- [ ] Watch logs briefly after deploy.

## Pull requests (optional for solo)

A **PR (Pull Request)** is a merge proposal on GitHub: review diff, optionally CI, then merge. Solo developers can skip PRs and merge locally; the important part is **which branch triggers which deploy**.

## Operational notes (eBay sandbox images)

- Sandbox gallery may show **small** URLs (`…/s-l140.jpg`) while full-size/lightbox uses larger variants (`…/s-l1600.jpg`).
- **Processing lag:** main image viewer may show “Image not available” briefly; after waiting, hover/main viewer often works. Fullscreen/lightbox can work before the main viewer catches up.
- If a URL is `http://` on an HTTPS listing page, browsers may block mixed content; `https://` for the same path often loads. Production behavior is usually more consistent than sandbox.

## Sheet defaults (self-documenting rows)

When using the app’s sheet export, default column values can include:

- `price`: `0.99`
- `ebay_category_id`: `259104`
- `merchant_location_key`: `HomeBaseWarehouse`

(Exact behavior lives in `src/lib/google-sheets-export.ts` — verify there if you change conventions.)

## Related

- Short commands only: `docs/SOLO_RELEASE_CHEATSHEET.md`

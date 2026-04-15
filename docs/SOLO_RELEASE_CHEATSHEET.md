# Solo release cheat sheet (ComicInfo)

Minimal commands when **you are the only developer** and want sandbox testing **without** accidentally shipping to production.

## Setup (once)

1. Create branch `release/prod` from a known-good `main`:

   ```bash
   git checkout main
   git pull origin main
   git checkout -b release/prod
   git push -u origin release/prod
   ```

2. In **Vercel**
   - Sandbox project: Production Branch = `main`
   - Production project: Production Branch = `release/prod`
3. Use **different env vars** per project (sandbox vs production eBay + sheets).

## Daily work (sandbox only)

```bash
git checkout main
git pull origin main
# edit code
npm run build
git add .
git commit -m "feat: short description"
git push origin main
```

Sandbox site updates from `main`. Production is unchanged.

## Promote sandbox-tested code → production

After you’re happy with sandbox:

```bash
git checkout release/prod
git pull origin release/prod
git merge --no-ff main
git push origin release/prod
```

Production deploys from `release/prod` only.

### Optional: cherry-pick one commit instead of merging all of `main`

```bash
git checkout release/prod
git pull origin release/prod
git cherry-pick <commit_sha>
git push origin release/prod
```

## Backup before a production promotion

```bash
git checkout release/prod
git pull origin release/prod
git tag -a prod-backup-$(date +%Y%m%d-%H%M) -m "Before production promote"
git push origin --tags
```

## If something goes wrong on `main` (sandbox)

Production is still on the last `release/prod` commit. Fix on `main`:

```bash
git checkout main
# fix, commit, push
```

No need to touch `release/prod` until the fix is validated again in sandbox.

## Quick mental model

```
main          → sandbox deploy
release/prod  → production deploy
```

Never point production at `main` if you want experiments isolated.

## Full narrative + checklists

See `docs/SANDBOX_TO_PROD_WORKFLOW.md`.

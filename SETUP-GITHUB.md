# Push this project to GitHub + set up CI/Vercel

**What to push:** the entire contents of this project (everything in the unzipped
folder — `src/`, `prisma/`, `tests/`, `package.json`, `.github/`, etc.). There is
no separate "build" to push; the source files are the deliverable. Do NOT push the
`.zip` itself — unzip it first and push the files inside.

Target repo: https://github.com/SummitSensory/SSG-CPQ-App.git (currently empty)

## 1. First push
```bash
cd <unzipped project folder>      # the folder that contains package.json
git init -b main
git add .
git commit -m "CPQ milestones 1-9: foundation, auth, CRM, catalog, rules, pricing, proposals, approvals"
git remote add origin https://github.com/SummitSensory/SSG-CPQ-App.git
git push -u origin main
```
On this push, `.github/workflows/ci.yml` runs automatically. See results in the
repo's **Actions** tab: typecheck, lint, format check, Prisma migrate, unit +
integration tests, then build + e2e — all against a throwaway Postgres.

## 2. What is safe to commit
- `.env` is gitignored — only `.env.example` is committed. **Never commit real secrets.**
- Everything else in the folder is meant to be committed.

## 3. Vercel (staging) — do after the repo exists
1. Import the GitHub repo into Vercel.
2. Add a serverless-friendly Postgres (Vercel Postgres / Neon).
3. Set these Environment Variables in the Vercel project (Settings → Environment Variables):
   - `DATABASE_URL`  — pooled connection string
   - `DIRECT_URL`    — direct connection string (migrations)
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — strong random values
   - `MONDAY_API_TOKEN`, `MONDAY_SIGNING_SECRET`, `MONDAY_DEALS_BOARD_ID`
   (`vercel.json` + `api/index.ts` are already in the project.)

## 4. Still open before "done"
- Add anonymized approved historical proposals under `tests/regression/fixtures/`
  to unblock the pricing regression (see `tests/regression/README.md`).
- Replace placeholder monday column ids in `src/integrations/monday/mapping.ts`.

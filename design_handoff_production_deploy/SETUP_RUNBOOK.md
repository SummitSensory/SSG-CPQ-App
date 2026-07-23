# SETUP & GO-LIVE RUNBOOK — Summit Sensory Gym CPQ

This gets you from "code exists" to "I can log in and test it," then to production. Work top to
bottom. Steps marked **[YOU]** require your accounts/credentials. Steps marked **[CLAUDE CODE]** can be
run by Claude Code on your machine (it executes the commands; you approve). Do not treat any phase as
done until its **Verify** line passes.

Two environments: **local** (fastest way to start testing) and **production** (Vercel + managed
Postgres). Do local first — you'll be testing within an hour without touching Vercel.

---

## PHASE 0 — Prerequisites [YOU]
Install and sign in once:
- Node.js LTS + `pnpm` (`npm i -g pnpm`)
- Git, and GitHub CLI: `gh auth login`
- Vercel CLI: `npm i -g vercel` then `vercel login`
- Claude Code CLI, opened in the project folder
- Accounts you'll need credentials from later: **Intuit Developer** (QuickBooks), **monday.com**
  (API token), and a **Postgres host** (Vercel Postgres or Neon/Supabase — free tier is fine)

**Verify:** `node -v`, `pnpm -v`, `gh auth status`, `vercel whoami` all succeed.

---

## PHASE 1 — Get the code into GitHub [CLAUDE CODE]
If the repo isn't on GitHub yet, tell Claude Code:
> "Initialize git if needed, create a private GitHub repo named `summit-cpq` under my account, commit
> all current code, and push to `main`. Confirm the remote URL."

Under the hood it runs roughly: `git init` → `git add -A` → `git commit` →
`gh repo create summit-cpq --private --source=. --push`.

**Verify:** `gh repo view --web` opens your repo and shows the latest commit.

---

## PHASE 2 — Run it locally so you can test TODAY

### 2a. Local database [YOU or CLAUDE CODE]
Easiest: create a free Postgres (Neon/Supabase/Vercel Postgres) and copy its connection string.
(Or run Postgres in Docker if you prefer local-only.)

### 2b. Environment file [CLAUDE CODE, values from YOU]
Ask Claude Code:
> "Create `.env` from `.env.example`. List every variable the app requires and tell me which ones I
> must supply values for. Fill in the ones you safely can (generate secrets); leave integration
> credentials as clearly-marked placeholders."

You'll need to paste real values for at least:
- `DATABASE_URL` and `DIRECT_URL` — your Postgres strings
- session/auth secret(s) — Claude Code can generate these
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT=sandbox`, QBO token encryption key
- `MONDAY_API_KEY`
- file-storage credentials (if used)

It's fine to start with **sandbox/placeholder** integration values — you can test everything except
live QBO/monday calls without them.

### 2c. Install, migrate, seed, run [CLAUDE CODE]
> "Run `pnpm install`, apply Prisma migrations to my dev database, seed a starter admin user and the
> reference catalog if a seed script exists, then start the dev server. Tell me the local URL and the
> admin login."

**Verify (local smoke test):** open the local URL, log in as admin, and create a customer →
opportunity → proposal → generate a PDF. If that works, the app is genuinely running.

---

## PHASE 3 — Wire the real integrations (sandbox first) [YOU + CLAUDE CODE]

### 3a. QuickBooks (Intuit Developer) [YOU]
1. Create an app at developer.intuit.com → get **Client ID / Client Secret** (Development keys).
2. Add the redirect/callback URL Claude Code gives you (local first, prod later).
3. Connect a **sandbox company**.
Paste the client id/secret into `.env`; keep `QBO_ENVIRONMENT=sandbox`.

### 3b. monday.com [YOU]
1. monday.com → Admin/Developers → **API token**.
2. Identify the target board (or let the app create one). Paste the token into `.env`.

### 3c. Verify integrations [CLAUDE CODE]
> "Run the integration verification: confirm the QuickBooks OAuth connect + token refresh + a
> read-only company-info call succeed WITHOUT creating any live estimate or invoice, and confirm a
> monday.com test item can be created on the sandbox board and then cleaned up. Report results."

**Verify:** QBO read-only check passes; monday test item created + removed. No unauthorized live
financial records.

---

## PHASE 4 — Production on Vercel [CLAUDE CODE drives, YOU approve]

### 4a. Production database [YOU or CLAUDE CODE]
Create a **separate** production Postgres (do not reuse dev). Copy its `DATABASE_URL` / `DIRECT_URL`.

### 4b. Link project + push env vars [CLAUDE CODE]
> "Run `vercel link` to connect this repo to a new Vercel project `summit-cpq`. Then push each
> required env var to the Vercel **Production** environment with `vercel env add` — I'll paste the
> secret values when prompted. Use production integration credentials and `QBO_ENVIRONMENT=production`
> only when I confirm I'm ready; otherwise keep sandbox."

### 4c. Migrate the production DB [CLAUDE CODE]
> "Take a backup snapshot of the production database first and record its id. Then apply Prisma
> migrations to production using `DIRECT_URL`. Confirm the schema version."

### 4d. Deploy [CLAUDE CODE]
> "Deploy to production with `vercel --prod`. Give me the deployment URL."

### 4e. Domain + SSL [YOU + CLAUDE CODE]
Add your custom domain in Vercel and update DNS as instructed; Vercel issues TLS automatically. Update
the QBO/OAuth callback URLs to the production domain.

**Verify:** production URL loads over HTTPS; you can log in.

---

## PHASE 5 — Production verification gate (do NOT declare success until all pass) [CLAUDE CODE]
Hand Claude Code the `design_handoff_production_deploy` runbook and say:
> "Execute Part C verification, steps 1–10, against production. Record evidence for each and write
> `PRODUCTION_RELEASE_REPORT.md`. Verify QuickBooks connection read-only — do not create live
> transactions. Stop and tell me if any step fails."

The 10 checks: smoke tests · role permissions · DB backups · monday sync · QBO connection (read-only)
· proposal PDF · audit logging · monitoring & alerts · rollback instructions documented · release
report produced.

**This is the real definition of done.** Code being written is not done. The app is "set up correctly"
only when Phase 5 passes with recorded evidence and no open release blockers.

---

## What only YOU can do (Claude cannot do these for you)
- Create/sign into Intuit, monday.com, Vercel, and the database host accounts.
- Approve billing and grant OAuth authorizations.
- Point your DNS at Vercel.
- Decide when to switch QBO from sandbox to production.

Everything else — repo creation, env wiring, migrations, deploy, verification — Claude Code can run on
your machine with the commands above. Feed it one phase at a time and check the **Verify** line before
moving on.

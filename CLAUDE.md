# CLAUDE.md

Operating procedure for Claude Code in this repository. Supersedes any prior
file-handoff workflow — Claude Code has direct write access to this repo and
is expected to use it.

## Repository snapshot

| Concern       | Choice                                                        |
| ------------- | ------------------------------------------------------------- |
| Runtime       | Node 22 (`.nvmrc`), pnpm (pinned via `packageManager`)        |
| Framework     | Fastify, TypeScript (strict)                                  |
| ORM / DB      | Prisma + PostgreSQL — **hand-authored migrations, see below** |
| Tests         | Vitest (unit/integration), Playwright (e2e)                   |
| Lint / format | ESLint (flat config) + Prettier                               |
| CI            | GitHub Actions: `.github/workflows/ci.yml`, `migrate.yml`     |

## Development workflow

1. Begin from an up-to-date `main` unless the task specifically requires
   another base.
2. Create a task-specific branch: `claude/<descriptive-task-name>`.
3. Inspect the existing implementation before modifying it. For anything
   touching the catalog/pricing data model, read `prisma/schema.prisma` and
   the "Data model" section below first — do not infer it from field names.
4. Make changes directly in this repository.
5. Preserve unrelated functionality.
6. Never send Bryan replacement source files or zip archives when the
   repository can be modified directly. That workflow is retired.

## Validation loop

Writing code does not constitute completion. After making changes, run all
applicable validation before considering the work done.

**Local validation needs a running database.** `pnpm db:drift`,
`pnpm db:migrate:status`, `pnpm db:check:integrity`, and
`pnpm test:integration` all need it. If it isn't running, first bring up the
repository's documented, safe local environment yourself —
`docker compose up -d db` — rather than escalating immediately. Diagnose
routine local environment problems (container not started, port conflict,
stale volume) the same way any other failure is diagnosed: inspect, fix,
re-run. Escalate only if the environment genuinely cannot be established:
missing credentials/access, an unavailable external dependency, a required
destructive action, or a condition that can't be safely resolved within
authorized permissions.

Mirror the CI pipeline (`.github/workflows/ci.yml`) locally, in this order:

```bash
pnpm install --frozen-lockfile   # only if dependencies changed
pnpm db:generate
pnpm typecheck                  # prisma generate && tsc --noEmit
pnpm lint
pnpm format:check
pnpm db:migrate:status
pnpm db:check:integrity
pnpm test                       # unit + integration
pnpm build
pnpm test:e2e                   # when routes/UI are touched; auto-starts the dev server
```

`pnpm check` bundles `typecheck` + `lint` + `db:drift` + `db:migrate:status` +
`db:check:integrity` — convenient, but it is not the full CI gate. Still run
`format:check`, `test`, and `build` separately (and `test:e2e` for anything
touching routes, the public app, or the portal).

If validation fails:

1. Inspect the actual failure output — don't guess.
2. Determine whether it was caused by this change or is pre-existing/environmental.
3. Fix problems caused by the work.
4. Re-run the failed validation.
5. Continue the diagnose → fix → validate loop until applicable checks pass.

Do not hand a failure back to Bryan merely because the first attempt didn't
work.

**Escalate to Bryan only when:**

- a business/product decision is genuinely required,
- required credentials/access are unavailable (e.g., no QuickBooks/Monday/
  Docuseal credentials for an integration path, or the local database can't
  be brought up because Docker itself isn't available/authorized),
- an external dependency prevents completion,
- the corrective action would be destructive or outside authorized
  permissions (see `.claude/settings.local.json`),
- or there is material ambiguity that can't be resolved from the repo or
  existing requirements.

## Git workflow

Before committing:

- run `git status`
- review `git diff`
- ensure no unrelated changes are included
- ensure secrets/environment files are not staged (`.env`, `.env.local`,
  `.env.preview` are gitignored — only `.env.example` is ever committed)
- ensure applicable validation has passed

Then:

- stage only intended changes
- create a descriptive commit (this repo's history is mostly terse `update`
  commits — write real messages going forward, don't match that pattern)
- push the `claude/*` feature branch: `git push -u origin claude/<name>`
- create a GitHub pull request: `gh pr create`

**Never:**

- force push
- push directly to `main`/`master`
- `git reset --hard`
- `git clean`
- rebase without explicit authorization
- force-add ignored files (`git add -f`/`--force`)
- amend commits
- merge the PR (`gh pr merge` is explicitly denied — a human merges)
- delete remote branches
- rewrite git history

These are enforced (not just documented) in `.claude/settings.local.json`.
That file is gitignored/per-machine — a new environment or contributor needs
its own permission setup; this file describes the intended process either way.

## Pull request

The PR description should summarize:

- objective
- implementation
- files/areas materially changed
- validation performed
- test/build results
- database/schema implications, if any (see the migration rule below —
  call these out explicitly, since a merge auto-deploys them to production)
- known limitations or remaining manual verification

GitHub Actions is an independent verification layer, not the only one:
`ci.yml` runs on every push/PR (typecheck, lint, format, migrations against a
throwaway DB, unit+integration tests, build, e2e). `migrate.yml` runs
separately, only after a merge to `main` that touches
`prisma/migrations/**` or `prisma/schema.prisma`, and applies those
migrations to the **production** database.

After creating or updating a PR, check the applicable GitHub Actions results
(e.g. `gh pr checks`, `gh pr view`, or the Actions tab) when reasonably
possible within the current session. A newly created PR with CI still
"pending" is not, by itself, a completed task — check again before reporting
completion if CI is still running.

If CI fails because of the implementation:

1. inspect the actual failure
2. diagnose it
3. correct it on the same feature branch
4. re-run applicable local validation
5. commit the correction
6. push the correction
7. check CI again

Continue that loop until implementation-related CI checks pass or a genuine
escalation condition exists (see Validation loop above). Do not attempt to
bypass, disable, weaken, or modify CI merely to obtain a passing result.

Do not consider a task complete while implementation-related CI failures
remain unresolved, or while CI status hasn't been checked at all.

## Definition of done

A normal development task is complete only when:

- requested functionality is implemented
- applicable local validation passes
- production build passes when applicable
- `git diff` has been reviewed
- intended changes are committed
- feature branch is pushed to GitHub
- PR is created
- CI status has been checked (not merely left pending)
- no known implementation-related failures are being ignored

## Final report to Bryan

At completion, report:

- what changed
- branch
- commit(s)
- PR link
- validation performed
- test results
- build result
- CI result
- any remaining risks/manual verification (e.g., "not opened in a browser" —
  see the note on E2E coverage below)
- whether Bryan needs to do anything

## Efficiency

Operate autonomously through routine implementation, testing, debugging,
validation, commit, push, and PR creation. Don't repeatedly ask Bryan for
permission, confirmation, or information when the answer is in the repo, the
action is already authorized, or the issue can reasonably be diagnosed and
corrected through testing. Bryan should be involved for business decisions,
material ambiguity, high-impact decisions, and final review — not routine
file handling or debugging.

## Project-specific engineering rules

**Database migrations — read `docs/database-migrations.md` before any
schema change.** `prisma migrate dev` does not work in this repo (its shadow
database can't replay the migration history) and every migration from
roughly `0029` onward is hand-written, guarded SQL. To make a schema change:

1. Edit `prisma/schema.prisma`.
2. `pnpm db:new <name> --guard` to generate the migration from the diff.
3. Read the generated SQL; guard anything flagged NOT GUARDED (idempotent
   `IF NOT EXISTS` / `DO $$ ... END $$` blocks — see the doc for the exact
   shapes).
4. Apply, record, and confirm no drift:
   ```
   npx prisma db execute --file prisma/migrations/<name>/migration.sql --schema prisma/schema.prisma
   npx prisma migrate resolve --applied <name>
   npx prisma generate
   pnpm db:drift   # must report "drift: none" before committing
   ```

Never edit an already-applied migration file — Prisma checksums it and
`migrate deploy` refuses to run in production if it doesn't match.

**Data model — read `prisma/schema.prisma` before writing any rule about
these; don't infer from field names:**

- A part is two rows: `Product` (name, category, tree position, sourcing)
  and `Sku` (price, cost, weight, vendor), joined by part number.
  `pnpm db:check:integrity` detects drift between them.
- Three different "category" fields, three jobs: `Product.categoryId` (tree
  position), `Sku.category` (part type: FRAME/TROLLEY/ACCESSORY),
  `Sku.proposalGroup` (proposal heading). Not copies of each other.
- `ProductSourcing` is many-to-many (`@@unique([productId, manufacturerId])`)
  with `isPrimary` defaulting to `true` — a part can have several vendors,
  several flagged primary. Never collapse to one vendor per part.
- The Bill of Materials reads `Sku.manufacturer` as the ordering override;
  `ProductSourcing` is what vendor reports and freight true-up read.
- The proposal builder **snapshots** the price onto the line when added,
  rather than reading the catalog live at print time. This is deliberate —
  do not "improve" it into a live lookup.

**Formatting exclusions.** `public/app.js` and `public/ssg-ui.js` are
excluded from Prettier in `.prettierignore` on purpose — reformatting either
would bury real changes in noise and break `git blame` on the busiest files
in the repo. Never run a repo-wide `pnpm format`; formatting on commit is
already scoped to staged files via `lint-staged`.

**Line endings.** Shell scripts and everything under `.husky/` must stay LF
(`.gitattributes`). CRLF breaks the hook shebang on a Windows checkout and
fails every subsequent push with "bad interpreter."

**Type safety.** `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`.
ESLint bans `@typescript-eslint/no-explicit-any` and
`@typescript-eslint/ban-ts-comment` — no `any`, no `@ts-ignore`/
`@ts-expect-error` suppressions. Fix the root cause.

**Money.** Integer minor units via `bigint` (`src/lib/money.ts`) — never
floats.

**Husky hooks are a safety net, not the validation loop.** `pre-commit` only
formats/lints staged files via `lint-staged`. `pre-push` runs typecheck,
lint, and unit tests — but silently lets a push through with a warning if
Node can't be resolved on the machine, and deliberately skips format-check,
integration tests, and `db:migrate:status` (network/DB dependent). Run the
full validation loop yourself regardless of what the hooks would have
caught.

**Known documentation drift.** `docs/github.md` previously described a
read-only, file-handoff workflow. It has been updated to reflect the
direct-repository-access model described in this file.

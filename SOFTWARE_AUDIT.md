# SOFTWARE_AUDIT.md

**Application:** Summit Sensory Gym — Proposal Management Software (SSG-CPQ-App)
**Audit opened:** 2026-08-28
**Status:** Pass 1 complete (static + architectural). Runtime, security-probe and performance passes NOT yet executed.

---

## 0. Method, and the limits of this pass

This audit is being conducted in passes, because the three kinds of evidence it needs are gathered in three different ways.

| Pass | What it covers                                                                                                 | Evidence                                   | State                                            |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| 1    | Architecture, code structure, incomplete work, schema design, authorization surface, obvious defects           | Reading the repository                     | **Complete**                                     |
| 2    | Runtime behaviour: workflows end to end, failure paths, permission enforcement, state consistency, persistence | Executing the app                          | **Not started** — needs a terminal and a browser |
| 3    | Measured performance, dependency vulnerabilities, test results, bundle size                                    | `pnpm test`, `pnpm audit`, `tsc`, devtools | **Not started**                                  |

Findings below are marked with confidence. **A finding is never marked Fixed until it has been retested at runtime.** Nothing in this file asserts that a workflow works; only that the code implementing it does or does not appear correct.

Pass 2 and 3 require a test plan; §11 is that plan, written so each check has an expected result and can be run in order.

---

## 1. Executive summary (Pass 1)

This is a mature, unusually well-documented codebase for a single-company internal system. The engineering conventions are consistent and deliberate: money is integer minor units throughout, proposal arithmetic has exactly one implementation (`src/proposals/analytics.ts`), QuickBooks is treated as authoritative and mirrored rather than duplicated, integrations retry and sweep, and cron endpoints authenticate on a secret and refuse to run open. Comments explain _why_ a rule exists and frequently name the failure that motivated it. That is rare and valuable.

The risks are not in the business logic. They are structural:

1. **The migration history cannot be replayed.** `prisma migrate dev` fails against a shadow database, which means the normal Prisma workflow is unavailable and every schema change must be hand-written SQL. This is a working practice today and a serious hazard the first time someone forgets.
2. **The front end is one 16,500-line file.** A single syntax error blanks the entire workspace, and it is not covered by lint rules. This happened today.
3. **Test coverage does not reach the code that moves money.** Test infrastructure exists; the financially load-bearing functions have no tests referencing them.
4. **Nothing has been load-tested at data volumes 5× current.** Several code paths read whole tables.

Nothing found in Pass 1 suggests customer data exposure, but the authorization surface has NOT been probed at runtime — see AUD-010, and do not treat its absence from this list as a clean bill.

---

## 2. Architecture overview

**Shape:** a Fastify API and a static, dependency-free browser client, deployed as two Vercel serverless functions against a Neon Postgres database.

```
public/*.js (browser, no build step)      ─┐
  app.js            the workspace shell    │  served by src/routes/web.ts
  accounts-receivable.js, insights.js,     │  each self-installs its own nav entry
  goals.js, belt-shipments.js, …           │
                                          ─┘
              │ fetch, Bearer access token
              ▼
api/index.ts ──► src/app.ts ──► ~50 route modules (src/routes/*.ts)
api/render.ts (60s, 3GB — PDF rendering only)
              │
              ├── src/plugins/auth.ts      JWT access + refresh, Session rows
              ├── src/plugins/authz.ts     requirePermission(Permission.X)
              ├── src/authz/permissions.ts 30 permissions → 11 roles
              │
              ├── domain: proposals/ pricing/ crossborder/ handoff/ reporting/
              │           approvals/ catalog/ rules/ vendorColors/ portal/
              │
              ├── integrations/ quickbooks (OAuth, mirrored txns + payments)
              │                 monday      (boards, webhooks, portal invites)
              │                 microsoft   (Graph: send-as-user, SSO)
              │                 docuseal    (e-signature webhooks)
              │
              └── Prisma ──► Neon Postgres (~95 models, 72 migrations)

Scheduled (vercel.json → CRON_SECRET bearer):
  /cron/portal-delivery   13:00 UTC   retries, webhook re-sync, invite sweep, void sweep
  /cron/freight-pull      09:00 UTC
  /cron/receivables       11:00 UTC   QuickBooks balance refresh
  /cron/scheduled-reports 12:30 UTC   saved-report email (new)
```

**Authentication:** email/password with bcrypt, plus Microsoft Entra SSO. Access token + refresh token in `localStorage`; refresh rotates. `Session` rows in the database.

**Authorization:** a single `requirePermission` preHandler per route, permissions mapped to eleven roles, `SYSTEM_ADMIN` holding a wildcard. This is an internal CRM: every staff role sees every customer by design. The only customer-facing surface is the portal, which authorizes on an unguessable token rather than a login.

**Unauthenticated endpoint surface** (verified by enumeration, `src/routes/*.ts`): `/health*`, `/build-info`, `/`, `/favicon.ico`, `/auth/*` (login, refresh, logout, forgot/reset password), `/auth/sso/*`, four OAuth callbacks, five webhooks (DocuSeal, Resend, monday ×2, freight board), four `/cron/*` endpoints (bearer `CRON_SECRET`), and three `/portal/*` endpoints (path token + rate limit). Every other route carries a permission preHandler. That surface is appropriately small; whether each one validates its input is a Pass 2 question.

**Money:** integer minor units end to end. `versionTotals()` in `src/proposals/analytics.ts` is the sole implementation of proposal arithmetic, and the printed document, the price snapshot, QuickBooks and the reports all derive from it. This is the single most important invariant in the system.

---

## 3. Production readiness score

**Withheld until Pass 2.** A score derived from reading code, with no workflow executed and no permission probed, would be a number with nothing behind it. What Pass 1 supports is narrower and worth saying plainly: the application is **already in production use and functioning**, and the Pass 1 findings are about durability rather than immediate breakage.

---

## 4. Issue register (Pass 1)

---

**Issue ID:** AUD-001
**Severity:** HIGH
**Category:** Database / developer workflow
**Location:** `prisma/migrations/0001_init/`, `prisma/migrations/0000_baseline/`
**Problem:** `prisma migrate dev` cannot run. The shadow database replays migrations from the beginning and fails at `0001_init` with `ERROR: type "Role" already exists`, because `0000_baseline` already created it.
**Evidence:** Console output, 2026-08-28: `Error: P3006 — Migration 0001_init failed to apply cleanly to the shadow database.` Corroborated by the fact that every migration from ~0029 onward is hand-written, guarded, idempotent SQL rather than Prisma-generated output — the team has been working around this for some time.
**Why it matters:** The documented Prisma workflow is unavailable. Every schema change requires hand-written DDL that must be kept in agreement with `schema.prisma` by hand. Nothing verifies that agreement, so schema drift between the Prisma client's expectations and the actual database is possible and would surface as runtime query failures on a screen nobody was testing. It also means a new developer's first schema change fails confusingly.
**How to reproduce:** `npx prisma migrate dev --name anything`
**Recommended fix:** Squash the history. Take a `prisma migrate diff` from an empty database to the current schema, replace `0000_baseline` … `0013_*` with one baseline migration, and `migrate resolve --applied` it against production. Then add `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel` to the pre-push hook so drift between schema and database fails locally rather than in production. Document the hand-written-SQL rule in the README until the squash happens.
**Dependencies/Risks:** The squash touches migration history and production's `_prisma_migrations` table. High blast radius if rushed — and, importantly, it is not what makes this issue dangerous.
**Confidence:** High
**Status:** **In Progress** — remediated in two parts, deliberately split

**Part 1 — shipped 2026-08-28 (no production risk).** The hazard in AUD-001 is not the untidy history; it is that hand-written SQL can disagree with `schema.prisma` and nothing checks. Three changes remove that:

- `scripts/schema-drift-check.mjs` — diffs the live database against `schema.prisma` and prints the SQL that would reconcile them. Wired into `pnpm db:drift` (fails on drift), `pnpm check` (fails on drift), and `migrate-deploy.mjs` after a successful deploy (warns, prints, does not block the release).
- `scripts/new-migration.mjs` — `pnpm db:new <name> --guard` generates the next numbered migration from that same diff, in the house's guarded style, and prints the apply/record/verify commands. The hand-written workflow becomes one command that cannot forget a column.
- `pnpm db:migrate` previously pointed at `prisma migrate dev`, which cannot work here. It now exits with the reason and the right command, so the trap is disarmed rather than documented.
- `docs/database-migrations.md` — why `migrate dev` fails, the working procedure, why guarded SQL, and what drift means.

**Part 2 — deferred (the squash).** Full procedure with a rehearsal-on-a-branch step is in `docs/database-migrations.md`. Deferred because `migrate deploy` — what production actually uses — is not broken, and Part 1 removes the day-to-day risk without touching history. Schedule it when there are no pending migrations.

---

**Issue ID:** AUD-002
**Severity:** HIGH
**Category:** Testing
**Location:** `tests/unit/`, `tests/integration/`, `src/proposals/analytics.ts`, `src/crossborder/*`, `src/integrations/quickbooks/*`
**Problem:** ~~The functions that determine what a customer is charged appear to have no tests referencing them.~~ **Corrected on inspection — the original finding was wrong.** `versionTotals()` is tested by `version-totals-integer.test.ts` (integer safety, discount clamp, standard freight) and `bundle-totals.test.ts` (222 lines, built from the real Obie Pro proposal that double-counted). FX conversion is covered by `crossBorder.test.ts` including half-cent rounding, negative amounts and malformed rate strings. 47 unit test files exist.

The real gap is narrower, and is what has now been filled: the proposal **meta** paths (percentage discount, the TBD override fields, the legacy `freightMinor` column) and the **entire new reporting layer**, which shipped today with no tests at all.
**Evidence:** Enumeration of `tests/unit/` against the exported functions of `analytics.ts`, `query.ts`, `signedDeals.ts` and `goals.ts`. `src/proposals/analytics.ts` documents two production defects that reached QuickBooks — a dollar discount counted as zero, and a bundle double-counting an $11,268 line — the first of which sits squarely in the untested meta path.
**Why it matters:** `versionTotals()` writes the accepted price snapshot; the snapshot is asserted against the live total before a QuickBooks document will send. A regression here does not fail loudly — it produces a _successful_ push of a wrong number, which is exactly what the comments describe having happened twice.
**How to reproduce:** `pnpm test` and inspect coverage of `analytics.ts` (Pass 3 will confirm the exact gap).
**Recommended fix / applied 2026-08-28:** Two new files, both pure-function, no database.

- `tests/unit/version-totals-meta.test.ts` — 18 cases: percentage vs amount discount (including the mode being authoritative when both fields carry values, which is the exact shape of the QuickBooks defect), negative and fractional percentages, TBD overrides that are numbers vs wording vs an explicit typed zero, `$1,250.50` parsing, the legacy `freightMinor` fallback and its precedence, margin composition, and `metaOf` against every stored section shape.
- `tests/unit/reporting-engine.test.ts` — 22 cases: `runReport` grain selection (including switching on a filter alone), counting a proposal once per group rather than once per line, the line-grain warning, milestone dating excluding never-reached milestones, inclusive date bounds, sort defaults, win rate recomputed from components rather than averaged; `signedDeals` month spans, per-milestone dating, cumulative totals and as-of-now gaps; `periodBounds` for month/quarter/year including December; `goalProgress` period isolation, owner narrowing, unit counting excluding optional lines, pace, capped fill vs uncapped ratio, and zero-target safety.

**Dependencies/Risks:** None. The tests encode two behaviours that look like bugs and are not — proposal value deliberately over-summing at line grain, and fill capping at 1 while ratio exceeds it — so a future "fix" trips a test with an explanation attached.
**Confidence:** High
**Status:** **Fixed — awaiting retest** (`pnpm test:unit`)

---

**Issue ID:** AUD-003
**Severity:** MEDIUM
**Category:** Maintainability / reliability
**Location:** `public/app.js` (16,550 lines, single IIFE)
**Problem:** The entire workspace shell — CRM, catalog, proposal builder, orders, BOM, admin, reports — is one file with no module boundaries and no build step. A syntax error anywhere blanks the whole application.
**Evidence:** This occurred today: a bad edit produced `Parsing error: Unexpected token ;` at line 10078, caught only by the pre-commit hook. Had it been committed, every screen would have been dead, not just the proposal document.
**Why it matters:** Risk scales with the file. Every change to any screen carries whole-application risk, review is impractical, and two people cannot work in it without conflicts.
**How to reproduce:** Introduce a syntax error anywhere in `public/app.js` and load the app.
**Recommended fix:** Do not rewrite it. Extract by attrition, using the pattern the codebase already proved: `accounts-receivable.js`, `belt-shipments.js`, `freight-trueup.js`, `insights.js` and `goals.js` are self-contained screens that install their own nav entry and fail in isolation. Every _new_ screen goes in its own file (already the practice), and each time an existing screen needs substantial work, lift it out then. Highest-value first extractions: the proposal document renderer (~1,200 lines, changed most often, most business-critical) and the Administration screens (~2,500 lines, changed rarely, low risk to move).
**Dependencies/Risks:** Extraction must preserve shared helpers (`esc`, `fmtMoney`, `authed`, `rt`). Duplicating them per file is the existing convention and is acceptable; a shared `ssg-common.js` would be better but changes load order.
**Confidence:** High
**Status:** Open

---

**Issue ID:** AUD-004
**Severity:** MEDIUM
**Category:** Tooling / quality gate
**Location:** `eslint.config.js`
**Problem:** ESLint rules are configured only for `**/*.ts`. The browser code — which is the majority of the UI by line count — has no rule coverage; only parse errors are caught.
**Evidence:** `eslint.config.js` declares one rules block, `files: ['**/*.ts']`. Today's incident surfaced as a bare parse error, with no rule to catch the dead code and duplicated ternary arm that accompanied it.
**Why it matters:** Unused variables, accidental globals, `==` coercion, unreachable code and shadowed declarations all pass silently in the largest part of the codebase.
**Recommended fix:** Add a `files: ['public/**/*.js']` block with `languageOptions: { globals: browser, sourceType: 'script' }` and a conservative rule set (`no-unused-vars` warn, `no-undef` error, `eqeqeq` warn, `no-redeclare` error). Expect an initial backlog of warnings in `app.js`; set them to `warn` so the gate does not block work, and fix them as files are extracted per AUD-003.
**Dependencies/Risks:** None. Small.
**Confidence:** High
**Status:** Open

---

**Issue ID:** AUD-005
**Severity:** MEDIUM
**Category:** Performance / scalability
**Location:** `src/reporting/dataset.ts` (`buildDataset`), `src/routes/reports.ts` (`/reports/proposals`), `src/routes/reports.ts` (`/reports/cost-drift`)
**Problem:** Three reporting paths read entire tables into memory with no pagination. `buildDataset` loads every proposal with every version's `sections` and `items` JSON; `/reports/proposals` does the same with full status history; `/reports/cost-drift` loads every procurement line in the database.
**Evidence:** `prisma.proposal.findMany({ where: { archivedAt: null }, select: { versions: { … items: true, sections: true } } })` — no `take`, no cursor. `prisma.procurementLine.findMany({ … })` — whole table.
**Why it matters:** Cost is linear in total historical proposals, and a proposal's `items` JSON is large. At today's volume this is fine and the 60-second cache makes it cheap. At 5–10× the data it will approach the 30-second function limit and the memory ceiling, and it will do so on the reporting screens first — the ones an executive opens.
**Recommended fix:** Two steps, in order. (1) Narrow the read: `buildDataset` only needs the _latest_ version per proposal, so fetch versions with `take: 1, orderBy: { version: 'desc' }` inside the include rather than all of them — this alone removes most of the payload for revised proposals. (2) When volume warrants, add a nightly rollup table (`ProposalFactDaily`) that the reporting screens read, refreshed by the existing cron, leaving live queries only for the current period.
**Dependencies/Risks:** Step 1 is a small, safe change but must be verified against a proposal with several revisions, because the accepted-date logic in `dataset.ts` deliberately scans _all_ versions' status history. Keep that read separate and narrow (`select: { statusHistory }` only).
**Confidence:** High
**Status:** Open

---

**Issue ID:** AUD-006
**Severity:** MEDIUM
**Category:** Reliability / integrations
**Location:** `src/routes/cronInsights.ts`, `src/integrations/microsoft/graph.ts`
**Problem:** Scheduled report delivery depends on one named individual's Outlook connection. If that person's token is revoked or they leave the company, the schedule stops and the only signal is a `lastSendError` string on a card nobody has a reason to open.
**Evidence:** `sendOutlookMail({ userId: sender, … })` where `sender = r.sendAsId ?? r.createdById`; the failure path writes `lastSendError` and returns.
**Why it matters:** Silent cessation of a report someone relies on is worse than a visible failure, because the absence of an email reads as "nothing happened this week."
**Recommended fix:** On failure, also alert through the existing `src/lib/alerts.ts` path, and surface a banner on the Insights screen when any shared saved report has a `lastSendError`. Longer term, a service mailbox rather than a personal one would remove the dependency entirely — but that is an Entra app-permission change, not a code change.
**Dependencies/Risks:** Small. Reuses existing alerting.
**Confidence:** High
**Status:** Open

---

**Issue ID:** AUD-007
**Severity:** LOW
**Category:** Correctness / cross-border
**Location:** `src/crossborder/snapshot.ts` (`rateAsOfFor`), fixed 2026-08-28
**Problem:** Draft proposals were pinned to the exchange rate of the day the draft was created, so a proposal opened a week later still quoted a rate that was never offered to anyone.
**Evidence:** Proposal P-2026-000098, dated 2026-08-28, printed a rate observed 2026-08-24.
**Why it matters:** A CAD figure on a document a customer reads should be a rate that could be honoured.
**Recommended fix:** Applied — released versions stay pinned to `releasedAt`; unreleased drafts resolve today's date.
**Dependencies/Risks:** The resolution cache is keyed by requested date, so a draft now costs at most one Bank of Canada call per day.
**Confidence:** High
**Status:** Fixed — **awaiting retest** (open a Canadian draft tomorrow and confirm the banner shows tomorrow's observation date)

---

**Issue ID:** AUD-008
**Severity:** LOW
**Category:** Data integrity
**Location:** `prisma/schema.prisma` — `SalesGoal.ownerId`, `SavedReport.createdById`, `CustomerNote`, `VendorPartNumber`, and others
**Problem:** Several `*ById` columns are not foreign keys to `User`, by deliberate convention documented in the migrations.
**Evidence:** `0042_customer_notes/migration.sql`: "NOT a foreign key — a deleted or rejected proposal must leave its notes behind." Same pattern in `0047` and `0048`.
**Why it matters:** The convention is defensible — a deactivated user must not take records with them — but it means orphaned ids accumulate and every read resolves names through a lookup that can miss. The risk is display-only ("—" where a name should be), not corruption.
**Recommended fix:** Keep the convention; make it explicit. Add a periodic integrity report (extend the existing `/health/schema` check) counting rows whose `*ById` no longer resolves, so orphans are visible rather than discovered.
**Dependencies/Risks:** None.
**Confidence:** High
**Status:** Open

---

**Issue ID:** AUD-009
**Severity:** LOW
**Category:** Consistency
**Location:** `src/routes/reports.ts` and `src/reporting/*`
**Problem:** Two reporting stacks now exist side by side: the original `/reports/proposals` bundle (`proposals/analytics.ts` → `buildReport`) and the new `/insights/*` engine (`reporting/dataset.ts` → `runReport`). Both compute win rates, product demand and per-rep figures from the same underlying data through different code.
**Evidence:** `ReportBundle.products` / `byPreparer` in `analytics.ts` overlap `Dimension: SKU|PRODUCT|REP` in `query.ts`.
**Why it matters:** They agree today because both call `versionTotals()`. They will drift the first time one is changed and the other is not, and two reports disagreeing is worse than either being wrong.
**Recommended fix:** Do not merge them now — the new engine needs a few weeks of real use first. Once it has proved itself, reimplement the Reports tabs on top of `runReport` and delete `buildReport`. Until then, add a note at the top of both files pointing at the other.
**Dependencies/Risks:** Deferred by design.
**Confidence:** High
**Status:** Open — deferred

---

**Issue ID:** AUD-011
**Severity:** HIGH
**Category:** Testing / quality gate
**Location:** `tests/unit/qbo-duplicate-prevention.test.ts`; `.husky/pre-push`; `package.json` `check`
**Problem:** Two of the three tests guarding against billing a customer twice have been failing, and nothing stopped a commit, a push or a deploy.
**Evidence:** `pnpm test:unit`, 2026-08-28: `TypeError: Cannot read properties of undefined (reading 'findFirst')` at `src/crossborder/sellerCharges.ts:77`, thrown from `prepareTransaction`. 452 tests pass, 2 fail. The mock `prisma` in that file predates cross-border; `prepareTransaction` now calls `sellerCollectedCharges()`, which reaches `proposalCrossBorderSnapshot`, `crossBorderSetting` and `address` — none of which the mock provides. The test therefore threw before its first assertion.
**Why it matters:** Two things, and the second is worse than the first. (1) The idempotency guarantee — same key returns the same row, and the QuickBooks `requestid` equals the idempotency key — has been unverified since cross-border shipped. That guard is what stands between a double-clicked button and a customer being invoiced twice. (2) The failure was invisible: `.husky/pre-push` runs `typecheck` and `lint` but **not** `test`, and `pnpm check` does not include tests either. A red suite has therefore been able to sit in main indefinitely, which makes every other test in the repo worth less than it looks.
**How to reproduce:** `pnpm test:unit`
**Recommended fix:** Two parts. (a) Add the three missing models to the mock, answering null — the ordinary US case, which is what these tests assert on. Applied. (b) Put the unit suite in the pre-push hook so this cannot recur. Deliberately _not_ the integration suite: those reach Neon and a push must not fail because a laptop is offline — the same reasoning the hook already gives for excluding `db:migrate:status`.
**Dependencies/Risks:** (a) is small and contained. (b) adds ~3 seconds to a push and will block pushes while any unit test is red, which is the point.
**Confidence:** High
**Status:** **Fixed and retested.** (a) Mock repaired — the three cross-border models, plus `product` and `acceptedOrder`, plus a Proxy so any model the domain grows tomorrow answers null instead of being undefined. The four collaborators on the execute path (SKU preflight, term lookup, custom-field slot, monday deal references) are now stubbed; they were unmocked network calls hidden behind a generic 502. (b) `pnpm test:unit` added to `.husky/pre-push`, approved 2026-08-28. Integration suite deliberately excluded — it needs Neon, and a push must not fail because a laptop is offline. Suite: **454 passed, 0 failed.**

---

**Issue ID:** AUD-012
**Severity:** MEDIUM
**Category:** Defect — money path
**Location:** `public/app.js`, the QuickBooks panel's "Re-freeze the accepted price" handler
**Problem:** The failure branch called `fail(r2, …)`, but `fail` is a `var` local to `loadBomSections` — a different function. The call threw a ReferenceError.
**Evidence:** `no-undef` at `public/app.js:13765`, the only such warning in the file. `var fail` is declared at 1348 (a different scope) and 12721 (`loadBomSections`); the call site is inside `loadQbo`.
**Why it matters:** Re-freezing restates the accepted total, the deposit and the order's figures. When the request failed, the user was told nothing: no alert, no message, and the button had already been re-enabled — so the natural reading is that it worked. A silent failure on the one action that changes an accepted price is the worst place for one.
**How to reproduce:** Open an order's QuickBooks panel with a price drift, make the re-freeze request fail (offline, or a 409 from the server), click Re-freeze. Console shows `ReferenceError: fail is not defined`; the screen shows nothing.
**Recommended fix:** Applied — read the server's message inline and alert it, matching the pattern used everywhere else in that panel.
**Dependencies/Risks:** None.
**Confidence:** High
**Status:** Fixed — **awaiting retest**

---

**Issue ID:** AUD-013
**Severity:** MEDIUM
**Category:** Defect — UI state
**Location:** `public/app.js`, `loadQbo` — the `qboRefreeze` and `qboRefresh` buttons
**Problem:** Both buttons were held in a variable named `rf`, declared twice with `var` in the same function scope. The second declaration rebinds the name for the whole scope, so the re-freeze handler's `rf.disabled = true` disabled the **refresh** button instead.
**Evidence:** `no-redeclare` at `public/app.js:13773`; declarations at 13759 and 13773 inside one function.
**Why it matters:** The re-freeze button stayed clickable while its own request was in flight — so a double click sends the restatement twice — and the refresh button greyed out for no visible reason. The guard was written correctly and applied to the wrong element.
**How to reproduce:** Open the QuickBooks panel, click Re-freeze, and watch which button greys out.
**Recommended fix:** Applied — the refresh button is now `rfr`.
**Dependencies/Risks:** None.
**Confidence:** High
**Status:** Fixed — **awaiting retest**

---

**Issue ID:** AUD-014
**Severity:** LOW
**Category:** Dead code
**Location:** `public/app.js:11949` and `:12102` — `bomFieldStyle`
**Problem:** Declared twice. Function declarations hoist, so the later two-argument version had been serving every caller; the earlier one-argument version was unreachable.
**Evidence:** `no-redeclare` at `public/app.js:12102`.
**Why it matters:** No behavioural difference — the surviving version renders identically when `locked` is falsy — but a reader editing the first one would see no effect and have no idea why.
**Recommended fix:** Applied — the dead declaration is removed, with a comment saying where the live one is.
**Confidence:** High
**Status:** Fixed — **awaiting retest**

---

**Issue ID:** AUD-015
**Severity:** MEDIUM — needs your decision
**Category:** Possibly unreachable feature
**Location:** `public/app.js:13838` `openQboSend`, `:13855` `openQboReminder`
**Problem:** Both functions are fully implemented and **never called**. Nothing references them — no listener, no id, no data attribute anywhere in `public/`.
**Evidence:** `no-unused-vars` on both; a grep for `openQboSend`, `openQboReminder`, `qboSend` and `qboRemind` across `public/` returns only the two declarations.
**Why it matters:** Two possibilities and they need different answers. Either these are leftovers superseded by the Accounts Receivable screen's own send and reminder flow — in which case they are dead weight in a file that is already too big — or they are a feature that was built, never wired to a button, and quietly lost. I cannot tell from the code which, and deleting a working QuickBooks send dialog on a guess would be the wrong kind of tidying.
**Recommended fix:** Your call: delete, or wire them into the QuickBooks panel. Left in place until you say.
**Dependencies/Risks:** If they are wired up, they send documents to customers — that path needs testing before it ships, not after.
**Confidence:** High (that they are unreferenced); n/a (on intent)
**Status:** Open — awaiting your decision

---

**Issue ID:** AUD-010
**Severity:** UNKNOWN — requires Pass 2
**Category:** Security / authorization
**Location:** `/portal/colors/:token`, `/webhooks/*`, `/cron/*`, the four OAuth callbacks
**Problem:** Not a finding. A placeholder, recorded so its absence from the register is not mistaken for a clean result. The unauthenticated surface has been _enumerated_ but not _probed_.
**What must be tested (Pass 2):** portal token expiry and single-use behaviour; whether a submitted portal selection can be replayed; whether webhook endpoints verify signatures (DocuSeal, Resend, monday) or merely accept a payload; whether OAuth callbacks validate `state`; whether `/cron/*` endpoints are reachable without the bearer in preview environments; and whether any `:id` route trusts the id without checking the caller may see that record.
**Recommended fix:** Pending results.
**Confidence:** n/a
**Status:** Open — blocked on Pass 2

---

## 5. Incomplete features

Pass 1 found **no abandoned or placeholder functionality** in the shipped surface. Specifically checked and found complete: proposal builder → release → e-sign → accepted order → BOM → vendor send; QuickBooks estimate/invoice/payment mirroring; cross-border tax and customs; freight RFQ and true-up; payment requests PAY-01…07; portal delivery and colour selection.

Three items are genuinely pending, all known:

| Item                           | State                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Insights / Goals (built today) | Code complete, migration applied locally, **not yet exercised against real data**                                        |
| Scheduled report email         | Cannot be tested locally; first real run is the morning after deploy                                                     |
| `docs/enhancement-queue.md`    | A backlog file — read it before Phase 6 planning; it may already contain decisions this audit would otherwise rediscover |

---

## 6–9. Security, performance, UX and coverage findings

Deferred to Passes 2 and 3. Writing these sections from static reading alone would produce plausible prose with no evidence, which is worse than an empty section. §11 is the plan that fills them.

---

## 10. Remediation plan

Phases are ordered by risk of _future_ damage, since nothing found in Pass 1 is actively breaking production.

### Phase 0 — Finish the audit (do this before any remediation)

| #    | Work                                                | Effort |
| ---- | --------------------------------------------------- | ------ |
| P0.1 | Execute the Pass 2 runtime test plan (§11)          | Medium |
| P0.2 | Execute the Pass 3 automated checks (§11)           | Small  |
| P0.3 | Resolve AUD-010 from those results; score readiness | Small  |

### Phase 1 — Durability of the quality gates

| #    | Issue   | Work                                                       | Effort |
| ---- | ------- | ---------------------------------------------------------- | ------ |
| P1.1 | AUD-002 | Unit tests for `versionTotals`, FX conversion, `runReport` | Small  |
| P1.2 | AUD-004 | ESLint coverage for `public/**/*.js`                       | Small  |
| P1.3 | AUD-001 | Squash migration history; add drift check to pre-push      | Medium |

### Phase 2 — Functional completion

| #    | Issue   | Work                                                                                   | Effort |
| ---- | ------- | -------------------------------------------------------------------------------------- | ------ |
| P2.1 | —       | Verify Insights/Goals against production data; correct anything the real shapes expose | Small  |
| P2.2 | AUD-007 | Retest the draft-FX fix on a fresh day                                                 | Small  |
| P2.3 | AUD-006 | Alert on scheduled-report failure                                                      | Small  |

### Phase 3 — Reliability and maintainability

| #    | Issue   | Work                                                 | Effort |
| ---- | ------- | ---------------------------------------------------- | ------ |
| P3.1 | AUD-003 | Extract the proposal document renderer from `app.js` | Medium |
| P3.2 | AUD-008 | Orphaned-reference report in `/health/schema`        | Small  |
| P3.3 | AUD-009 | Note the two reporting stacks; plan consolidation    | Small  |

### Phase 4 — Performance

| #    | Issue   | Work                                                     | Effort |
| ---- | ------- | -------------------------------------------------------- | ------ |
| P4.1 | AUD-005 | Narrow `buildDataset` to the latest version per proposal | Small  |
| P4.2 | AUD-005 | Rollup table, only if Pass 3 measurement justifies it    | Large  |

### Phases 5–6 — UX and product

Cannot be planned before Pass 2. Deliberately empty.

---

## 11. Test plan for Passes 2 and 3

Run in this order and paste the output back; each step says what a pass looks like.

### Pass 3 — automated (fastest, do first)

```powershell
pnpm test                 # expect: all green; note which files have no tests
npx tsc --noEmit          # expect: no output
pnpm audit --prod         # expect: no high/critical; record what appears
npx depcheck              # expect: list of unused deps (informational)
pnpm build                # expect: success
```

### Pass 2 — runtime, in this order

1. **Auth.** Log in; refresh the page (session survives); log out and press Back (no data); paste an expired access token into a request (401 then refresh); request a password reset twice and reuse the first link (expect refusal).
2. **Authorization.** Log in as READ_ONLY. Attempt, via devtools, `POST /proposals`, `PATCH /insights/goals/:id`, `GET /reports/cost-drift`. Expect 403 on the first two. Then as SALES_REP attempt to archive another rep's proposal — expect refusal by ownership, not just a hidden button.
3. **Portal isolation.** Mint a colour-selection link. Submit it. Submit the same token again. Alter one character of the token. Expect: accepted, refused-or-idempotent, 404. Then wait past expiry if one exists.
4. **Webhook authenticity.** `POST /webhooks/docuseal` with a syntactically valid body and no signature, from outside. If it is accepted, that is a CRITICAL finding — record it and stop.
5. **Money.** Take one accepted order and compare, by eye: proposal document total, `PriceSnapshot.grandTotal`, the QuickBooks invoice total, and the Reports figure. All four must agree to the cent.
6. **Cross-border.** Open a Canadian draft; confirm the FX banner shows today's observation. Release it; confirm the rate freezes.
7. **Insights/Goals.** The six-step smoke test from earlier, against production data.
8. **Failure paths.** Disconnect QuickBooks and load Accounts Receivable; revoke Outlook and try a payment request; break the Bank of Canada call (block the host) and open a Canadian proposal. Each should degrade with a readable message, not a blank screen.
9. **Responsive.** Load the workspace at 1280, 1024 and 768 px. Record what breaks; the client is desktop-first and this is expected to produce findings.

---

## 12. Validation history

| Date       | Event                                                                   | Result                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-28 | AUD-007 fix applied (draft FX)                                          | Deployed; retest pending                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-28 | Proposal document spacing / tier heading / EOR box                      | Applied and committed                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-28 | Insights, report builder, Goals added                                   | Committed; runtime verification pending                                                                                                                                                                                                                                                                                                                         |
| 2026-08-28 | Pass 1 audit                                                            | Complete — 9 findings, 1 placeholder                                                                                                                                                                                                                                                                                                                            |
| 2026-08-28 | AUD-001 Part 1: drift check, migration generator, disarmed `db:migrate` | Shipped                                                                                                                                                                                                                                                                                                                                                         |
| 2026-08-28 | AUD-001 retest                                                          | **Passed, and immediately earned its keep** — `pnpm db:drift` caught a real mismatch in migration 0072 (`updatedAt` given a database default that Prisma's `@updatedAt` does not declare). Fixed by `0073_reporting_updated_at_defaults` rather than by editing an applied migration. First use of the new workflow end to end.                                 |
| 2026-08-28 | AUD-002 finding **corrected**                                           | The original claim of no coverage was wrong: 47 unit test files exist, including two for `versionTotals` and full FX coverage. Finding rewritten to the actual gap.                                                                                                                                                                                             |
| 2026-08-28 | AUD-002 fix: meta-path and reporting-engine tests                       | **Retested — passed.** 38 new cases green (version-totals-meta 15, reporting-engine 23); suite 452 passed / 454                                                                                                                                                                                                                                                 |
| 2026-08-28 | AUD-011 discovered **by** that retest                                   | Two QuickBooks duplicate-prevention tests were already failing, unnoticed, because the pre-push hook did not run tests                                                                                                                                                                                                                                          |
| 2026-08-28 | AUD-011 fix                                                             | **Retested — 454 passed, 0 failed.** Mock repaired and made drift-resistant; `pnpm test:unit` added to pre-push so a red suite can no longer reach main                                                                                                                                                                                                         |
| 2026-08-28 | AUD-004 fix: ESLint rules for `public/**/*.js`                          | Shipped. First run: 223 warnings, 0 errors — and **four real findings inside the noise**, logged as AUD-012 (a ReferenceError on the re-freeze money path), AUD-013 (two buttons sharing one `var`), AUD-014 (dead duplicate function) and AUD-015 (two unreferenced QuickBooks dialogs). Config then tuned so intentional empty catches stop drowning findings |
| 2026-08-28 | AUD-004, 012, 013, 014                                                  | **Retested — passed.** `pnpm lint:count`: **223 → 11 warnings, 0 errors.** No `no-undef` and no `no-redeclare` remain, which is the specific evidence that AUD-012 (the ReferenceError) and AUD-013 (two buttons sharing one `var`) are gone. The 11 survivors are all unused declarations — dead code, no behaviour                                            |
| 2026-08-28 | Node version pinned via `.nvmrc` (local was v24, production 22)         | Applied                                                                                                                                                                                                                                                                                                                                                         |

---

### Dead-code backlog (from AUD-004, 11 warnings)

Every remaining warning is an unused declaration. None affects behaviour; all are read-once decisions rather than work.

| Location               | Name              | Likely story                                             |
| ---------------------- | ----------------- | -------------------------------------------------------- |
| `app.js:13852`         | `openQboSend`     | See AUD-015 — needs a decision, not a deletion           |
| `app.js:13869`         | `openQboReminder` | See AUD-015                                              |
| `app.js:2543`          | `renderSkus`      | Superseded by the catalog screens?                       |
| `app.js:14173`         | `printTable`      | A print helper nothing calls                             |
| `app.js:10567`         | `cargoNetOn`      | A proposal option that may have been removed from the UI |
| `app.js:11421`         | `SIZE_ORDER`      | An ordering constant left after a sort changed           |
| `app.js:6191`          | `mmax`            | Local, harmless                                          |
| `app.js:10022`         | `groupName`       | Assigned in the document renderer, never read            |
| `app.js:12493`         | `name`            | Local, harmless                                          |
| `contract-pages.js:18` | `paras`           | Helper left after the terms pages were rewritten         |
| `freight-trueup.js:62` | `GREEN`           | Unused palette entry                                     |

Recommendation: leave them until each file is next opened for other work, then remove as you go. Deleting nine things at once across a 16,500-line file is a diff nobody can review, for no behavioural gain. The exceptions are the two `openQbo*` functions, which are a product question rather than tidying.

---

## 13. Current overall status

**Pass 1 complete. Awaiting execution of Passes 2 and 3 before a readiness score, a security verdict, or any remediation beyond what is already applied.**

No broad remediation has begun, per the approval checkpoint.

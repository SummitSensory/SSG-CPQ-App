# AUDIT_REPORT.md — Summit Sensory Gym Proposal Builder

Audit date: 2026-08-17
Auditor: inherited-system review (adversarial, code-level)
Repository under review: `SummitSensory/SSG-CPQ-App` (working copy attached to this project)
Corrected code: `fixes/` — mirrors the repo path of every file changed; copy straight over the original.

---

## 0. Scope, and what could not be verified

**Environment constraint, stated first because it bounds every conclusion below.** This
audit ran with read access to the repository and write access to a fixes workspace.
There was **no shell, no package manager, no database, no git, and no ability to start
the application**. Therefore:

| Required check                                 | Result                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Production build (`pnpm build`)                | **NOT RUN** — no shell                                                                                                               |
| Type check (`pnpm typecheck`)                  | **NOT RUN** — no shell                                                                                                               |
| Lint (`pnpm lint`)                             | **NOT RUN** — no shell                                                                                                               |
| Unit tests (`pnpm test:unit`)                  | **NOT RUN** — tests written, not executed                                                                                            |
| Integration tests                              | **NOT RUN**                                                                                                                          |
| E2E (Playwright)                               | **NOT RUN**                                                                                                                          |
| Dependency audit                               | **NOT RUN** — no registry access                                                                                                     |
| Migration validation (`prisma migrate status`) | **NOT RUN** — no database                                                                                                            |
| Live data-isolation probing (Phase 5)          | **NOT RUN** — no running instance                                                                                                    |
| Git branch / commits (Phase 0)                 | **NOT POSSIBLE** — no git; recoverability preserved instead by writing every change to `fixes/` and never modifying the working copy |

**Consequence:** the corrections in `fixes/` are code-reviewed and unit-test-covered by
construction, but **not compiled and not executed**. They must be type-checked, linted
and tested in the repository before deployment. Nothing in this report should be read as
"verified at runtime" unless it says so.

**Depth of coverage.** The audit prioritised the paths where a defect costs money,
customer trust, or data: authentication, authorisation, the proposal write path, money
arithmetic, document generation, document numbering, and the integration idempotency
boundary. Areas read only shallowly, and therefore **unaudited**, are listed in
`PRODUCTION_READINESS_REPORT.md` §4 — they include the catalog import, the rules engine,
the Adventure/Soar configurators, the freight true-up service, reporting aggregates, the
Microsoft/Outlook integration, and the 12,681-line browser client beyond the specific
flows traced.

---

## 1. Architecture map (derived from code, not assumption)

| Layer           | Finding                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime         | Node ≥ 22, ESM, TypeScript 5.6, pnpm 9.12 (`package.json`)                                                                                                                                                                                                                                                   |
| HTTP            | Fastify 5, single `buildApp()` in `src/app.ts` registering ~40 route modules                                                                                                                                                                                                                                 |
| Deployment      | Vercel serverless (`vercel.json`); `/render/*` split to a 2 GB / 60 s function for headless Chromium; Render/Docker configs also present                                                                                                                                                                     |
| Frontend        | Server-served static shell: `public/index.html` + a single hand-written `public/app.js` (12,681 lines, no build step, no framework)                                                                                                                                                                          |
| Database        | PostgreSQL via Prisma 5.22 (`prisma/schema.prisma`, ~2,650 lines); money stored as `BigInt` minor units; a handful of `Float` columns for weights and formula factors                                                                                                                                        |
| AuthN           | Email + argon2 password, plus Microsoft Entra SSO (`src/auth/*`). Access = stateless HS256 JWT (15 min default); refresh = opaque 48-byte token hashed into `Session`                                                                                                                                        |
| AuthZ           | Role → permission table (`src/authz/permissions.ts`, 11 roles), enforced server-side by `requirePermission` preHandlers                                                                                                                                                                                      |
| Tenancy         | **Single tenant.** One Summit Sensory Gym instance; staff see all customers by design. "Cross-customer isolation" therefore applies to _external_ surfaces (signing links, webhooks, public pages), not to staff routes                                                                                      |
| Money           | `src/lib/money.ts` (bigint) and `src/pricing/engine.ts` (bigint, fully explained breakdown) exist; the **proposal path does not use either** — it uses `versionTotals()` in `src/proposals/analytics.ts` (JS numbers) mirroring `builderTotals()` in `public/app.js`                                         |
| Documents       | Proposal PDF is rendered **in the browser** and posted to the server as HTML for e-sign and monday upload; BOM PDFs/XLS are rendered server-side                                                                                                                                                             |
| Integrations    | monday.com (bi-directional, deal board 6527740233), QuickBooks Online (customers, estimates, invoices, payments; sandbox/production gated by `QBO_PRODUCTION_WRITE_ENABLED`), DocuSeal (e-sign), Resend (email + delivery webhooks), Microsoft Graph (Outlook drafts), Vercel Blob (signed-document storage) |
| Source of truth | CRM/CPQ owns customer fields pushed to QuickBooks (`src/integrations/quickbooks/source-of-truth.ts`); monday owns deal-level freight/tax figures and the Project ID; DocuSeal owns envelope state (re-read, never trusted from the webhook body)                                                             |
| Observability   | pino logger, `AuditLog` + per-entity event tables, `IntegrationSyncLog`. No error-monitoring service, no alerting, no metrics                                                                                                                                                                                |

---

## 2. Findings register

Severity is assigned on business impact, not on how exotic the trigger is.

---

### PROPOSAL-001 — Proposal content is written to the database with no server-side validation

**Status:** FIXED · **Severity:** CRITICAL · **Category:** Validation / data integrity / pricing

**Location:** `src/routes/proposals.ts`, `app.patch('/proposals/versions/:versionId')`

**Problem.** The handler read `req.body as { items?: unknown[]; sections?: ProposalSection[] }`
and passed both straight to `updateVersionContent` → Prisma. No schema, no bounds, no
type enforcement. `POST /proposals` has a zod schema (`CreateSchema`); the PATCH that
every subsequent save goes through has none. The only validation on the numbers a
proposal is built from was in `public/app.js`.

**Evidence.** Code inspection of the handler (pre-fix source quoted in
`REMEDIATION_LOG.md`). `CreateSchema` exists in the same file, 100 lines above, which
shows the omission is an oversight rather than a policy.

**Real-world impact.** Anything a caller can put in a JSON body becomes proposal
content: a negative quantity, a fractional cent, `rateMinor: 1e309`, a 50 MB
description, a `costEach` that contradicts the catalog, or arbitrary extra keys. From
there it propagates deterministically — `versionTotals()` → `PriceSnapshot.grandTotal`
(frozen at release) → the customer's PDF → the QuickBooks estimate and invoice → the
signed contract. A single malformed save produces a customer-facing document with a
wrong total and an accounting record that agrees with it. Any authenticated staff
account, including a compromised one, reaches this endpoint.

**Reproduction.** `PATCH /proposals/versions/<id>` with
`{"items":[{"lineType":"PRODUCT","quantity":-5,"rateMinor":12.5}]}` → 200, stored,
totalled.

**Root cause.** Validation was added at creation, where the shape was simple, and never
retrofitted to the builder's save, where the shape grew large. The `as` cast silenced the
type system that would otherwise have asked the question.

**Implemented fix.** New `src/proposals/validation.ts`: `VersionContentPatchSchema`,
`BuilderLineSchema`, `BuilderMetaSchema`, `assertMetaSectionsValid`. Money must be an
integer within ±1e12 minor units; quantity a non-negative integer ≤ 100,000; text
length-capped; ≤ 2,000 lines; discount percentage 0–100. Schemas `passthrough()` unknown
keys deliberately, so a newer client's extra fields are preserved rather than dropped.
The route now parses and reports the first offending field.

**Test coverage.** `tests/unit/proposals-validation.test.ts` — 8 cases (fractional money,
negative and fractional quantity, out-of-range money, null-vs-zero rate, line-count cap,
description cap, discount bounds, ordinary save passes through).

**Verification.** Tests written; **NOT RUN** (no shell). Requires `pnpm test:unit`.

**Confidence:** High that the defect is real; Medium that the new bounds match every
legitimate document already in the database (see `REMEDIATION_LOG.md` — a read-only
sweep of stored versions against the schema is the recommended pre-deploy step).

---

### PROPOSAL-002 — Concurrent creates collide on document numbers and fail with a 500

**Status:** FIXED · **Severity:** HIGH · **Category:** Database / reliability

**Location:** `src/proposals/service.ts` `nextNumber()`; `src/handoff/service.ts`
`nextOrderNumber()`

**Problem.** Both allocate read-then-write: `findFirst(orderBy number desc)` → parse →
`+1` → insert, with `Proposal.number` and `AcceptedOrder.number` both `@unique`
(`prisma/schema.prisma:1019`, `:1623`). Two requests in the same window read the same
high-water mark and attempt the same number; the loser throws Prisma P2002, which the
error handler surfaces as a 500.

**Evidence.** Code inspection plus the unique constraints in the schema.

**Real-world impact.** A rep presses "Create" and gets a server error on a proposal that
was never created — most likely exactly when the office is busiest. On the accept path it
is worse: the acceptance of a signed proposal fails for a reason that has nothing to do
with the acceptance. (The constraint did its job: no duplicate numbers were ever issued.
The failure mode is lost work and a false alarm, not corrupt data.)

**Reproduction.** Two simultaneous `POST /proposals`.

**Root cause.** Sequential-per-year numbering implemented in application code with no
collision handling.

**Implemented fix.** New `src/lib/documentNumber.ts` — `allocateNumbered()` wraps the
insert in a bounded retry (6 attempts), re-reading the high-water mark each time, and
rethrows any P2002 on a _different_ unique column untouched (so "this version is already
accepted" still reaches the caller as the conflict it is). Both allocators now use it.
Not converted to a database sequence: the format is `PREFIX-YEAR-NNNNNN` with a per-year
restart, and re-plumbing a number printed on signed customer documents is not an
audit-time change.

**Test coverage.** `tests/unit/document-number.test.ts` — 5 cases (sequence parsing,
violation discrimination, retry lands on the next free number, unrelated P2002
rethrown, attempt budget respected).

**Verification.** Tests written; **NOT RUN**.

**Confidence:** High.

---

### PROPOSAL-003 — No rate limiting on any authentication endpoint

**Status:** PARTIALLY FIXED · **Severity:** HIGH · **Category:** Authentication / availability

**Location:** `src/routes/auth.ts` — `/auth/login`, `/auth/forgot-password`,
`/auth/reset-password`; `src/app.ts` (no limiter registered)

**Problem.** `package.json` declares no rate-limit plugin and `app.ts` installs none.
Password attempts, reset-token submissions and reset-email requests were unbounded.

**Evidence.** Dependency list and `buildApp()` inspected; no throttle exists anywhere in
the request path.

**Real-world impact.** Three distinct exposures: credential stuffing against staff
accounts (which hold customer and financial data); reset-token guessing; and — because
`verifyPassword` is argon2 — a cheap CPU-exhaustion attack that costs the _server_ far
more than the attacker, on a serverless plan billed by execution.

**Root cause.** No limiter was ever added.

**Implemented fix.** New dependency-free `src/lib/rateLimit.ts` (fixed-window counters,
bounded map) wired into the three routes, keyed on **both** caller IP and the submitted
address, so neither an office NAT nor address rotation defeats it. Login: 10 / 15 min.
Reset request: 5 / hour. Reset submission: 20 / hour. A successful sign-in clears the
counters. 429 with `retryAfter`.

**Why PARTIALLY.** The counters live in one process's memory. On Vercel the effective
ceiling is (limit × live instances) and a cold start forgets everything. That is a
material reduction in attack rate, **not a hard bound**. The durable fix is a shared
store (Postgres or Redis) or a platform/edge rule; both are recorded as follow-ups. A
dependency was deliberately not added because the lockfile could not be resolved here.

**Test coverage.** `tests/unit/rate-limit.test.ts` — 5 cases.

**Verification.** Tests written; **NOT RUN**.

**Confidence:** High.

---

### PROPOSAL-004 — A deactivated or demoted user keeps their authority for the token's lifetime

**Status:** FIXED · **Severity:** HIGH · **Category:** Authorization

**Location:** `src/plugins/authz.ts` `requireAuth`; `src/auth/tokens.ts`;
`src/auth/session.ts` `revokeAllForUser`

**Problem.** The access token is a stateless HS256 JWT carrying `sub` and `role`.
`requireAuth` verified the signature and trusted the claims — it never looked at the
`User` row. `revokeAllForUser` (password change, reset, presumably deactivation) revokes
**refresh sessions only**; the access token in hand keeps working until it expires.

**Evidence.** Code inspection of all three files. `JWT_ACCESS_TTL` defaults to 900 s.

**Real-world impact.** For up to a full TTL after an admin deactivates an account — a
departure, a suspected compromise — the token still opens every route. And because the
_token's_ role was authoritative, a demotion (SALES_MANAGER → READ_ONLY) did not take
effect until the token expired either. Both cases are explicitly in the audit's required
scope ("access after a user is disabled", "access after a role changes").

**Root cause.** Stateless tokens adopted without a revocation or freshness check.

**Implemented fix.** `requireAuth` now resolves live account state (`isActive`, `role`)
with a 5-second in-process cache, refuses inactive and missing users, and attaches the
**database** role rather than the token's copy of it. Cost is roughly one indexed lookup
per user per 5 seconds; the cache holds no credentials.

**Test coverage.** `tests/unit/authz-live-account.test.ts` — 5 cases including "uses the
database role, not the role inside the token" and the cache assertion.

**Verification.** Tests written; **NOT RUN**.

**Confidence:** High. Residual: a 5-second window remains by design; shortening it to
zero is one line if the extra query is acceptable.

---

### PROPOSAL-005 — Two staff editing one draft silently overwrite each other

**Status:** PARTIALLY FIXED · **Severity:** HIGH · **Category:** Data integrity / concurrency

**Location:** `src/proposals/service.ts` `updateVersionContent`

**Problem.** The save is an unconditional `update` of `sections` and `items`. No version
token, no `updatedAt` precondition. Last write wins, and the loser's work disappears with
nothing reported. The same proposal open in two tabs does it to a single user.

**Evidence.** Code inspection: the update has no `where` clause beyond the id.

**Real-world impact.** A rep adds four lines while a manager fixes freight on the same
draft; whoever saves second erases the other's edits. Nobody is told, and the audit log
records both saves as successful.

**Root cause.** No optimistic-concurrency control on the builder's write path.

**Implemented fix (server).** `updateVersionContent` accepts an optional
`expectedUpdatedAt`; when supplied and stale (>1 s drift) the save is refused with a 409
and a plain message. The route accepts and forwards the field.

**Why PARTIALLY.** `public/app.js` does not yet send `expectedUpdatedAt`, so the
protection is inert until the client is updated (read `updatedAt` when the builder opens
and on each successful save; send it on the next save; on 409 show the conflict). That
client change is a **required follow-up**, listed in `REMEDIATION_LOG.md` §Follow-ups. It
was not made here because `public/app.js` is a single 12,681-line file and this project's
rules require whole-file delivery — an unreviewable diff of that size is a worse risk
than the one it closes.

**Test coverage.** Not unit-tested (the guard is inside a Prisma-dependent function); the
comparison logic is trivial and the behaviour needs an integration test against a
database — recorded as a coverage gap.

**Verification.** **NOT RUN.**

**Confidence:** High that the defect is real; the fix is verified by inspection only.

---

### PROPOSAL-006 — Any authenticated user can read any approval request by id

**Status:** FIXED · **Severity:** HIGH · **Category:** Authorization / IDOR

**Location:** `src/routes/approvals.ts` `app.get('/approvals/:id')`

**Problem.** The handler was `prisma.approvalRequest.findUnique({ where: { id },
include: { events } })` behind `requireAuth` only — no permission, no ownership, no queue
membership check. Every other approval action goes through `assertCanDecide`; the read
does not.

**Evidence.** Code inspection, contrasted with `queueFor()` in
`src/approvals/service.ts`, which filters the same rows through `canDecide()`.

**Real-world impact.** An approval request carries the reason for a discount, the value
requested against the value on record, the requester, and free-text supporting
information about a deal. A READ_ONLY or INSTALLER account — or any compromised staff
token — could enumerate ids and read the commercial reasoning behind every discount and
margin exception in the business.

**Reproduction.** Sign in as READ_ONLY, `GET /approvals/<any id>` → full record.

**Root cause.** Read paths were assumed harmless; authority was implemented only on the
decision paths.

**Implemented fix.** New `requestVisibleTo()` in `src/approvals/service.ts` returns the
request only to the requester, the deciding approver, an active delegate, or someone who
could act on it now — reusing the same `canDecide()` guard as the queue and the decision
endpoints, so one rule governs all three. Anyone else gets 404, not 403, so the id is not
confirmed.

**Test coverage.** Not unit-tested (Prisma-dependent); the existing
`tests/unit/approvals-policy.test.ts` covers `canDecide` itself, and an integration test
asserting a READ_ONLY 404 is recorded as a required addition.

**Verification.** **NOT RUN.**

**Confidence:** High.

---

### PROPOSAL-007 — The signed contract is built from HTML the client supplies, unchecked

**Status:** PARTIALLY FIXED · **Severity:** HIGH · **Category:** Document integrity

**Location:** `src/routes/esign.ts` `POST /render/esign/proposals/versions/:versionId/send`;
`src/routes/render.ts` `POST /render/proposals/versions/:versionId/monday-file`

**Problem.** Both endpoints take `proposalHtml` from the browser and turn it into the PDF
the business is bound by (the e-sign envelope; the deal board's copy of record). Nothing
compared that document to the stored proposal.

**Evidence.** Code inspection of both handlers: `proposalHtml` goes from the request body
to `renderPdf`/DocuSeal with no reference to the version's own `items`/`sections`.

**Real-world impact.** A stale tab, a half-applied freight true-up, or a crafted request
produces a signed PDF whose bottom line is not the proposal's. From then on the contract,
the QuickBooks invoice and the reports disagree, with no record of which is authoritative
— and the customer holds the document that says the lower number.

**Root cause.** A sound decision (the customer signs exactly what the rep previewed)
implemented without the check that makes it safe (the preview must agree with the
record).

**Implemented fix.** New `src/proposals/documentIntegrity.ts`: `checkDocumentTotal()`
computes the server's grand total via `versionTotals()`, formats it the way the document
formats money, and requires it to appear in the submitted HTML (tolerant of markup splits
and thousands separators; a zero total is exempt). Both routes refuse a mismatch with an
actionable message.

**Why PARTIALLY.** This verifies the bottom line, not the whole document — line items,
customer name and terms are still whatever the client sent. The complete fix is
server-side rendering of the proposal from stored state, which is a project, not a patch.
Also: **the check has not been exercised against a real rendered proposal** (no running
app), so it must be validated on a staging send before deploying — a false refusal would
block sends.

**Test coverage.** `tests/unit/document-integrity.test.ts` — 7 cases including a stale
total refused and a header discount reflected.

**Verification.** Tests written; **NOT RUN**. Staging send **NOT RUN**.

**Confidence:** High on the defect; Medium on the fix's tolerance for every real template.

---

### PROPOSAL-008 — Proposal money is accumulated in floating point

**Status:** FIXED · **Severity:** MEDIUM · **Category:** Pricing

**Location:** `src/proposals/analytics.ts` `versionTotals()`

**Problem.** Minor units are summed as JS numbers: `subtotal += qty * n(l.rateMinor)`.
Integer inputs make that exact, but nothing enforced integer inputs (see PROPOSAL-001),
so a legacy fractional `rateMinor` yields totals like `12345.000000000002`.

**Evidence.** Code inspection; the file's own header comments describe money as minor
units while the arithmetic makes no such guarantee.

**Real-world impact.** That residue reaches `PriceSnapshot.grandTotal`, and
`src/integrations/quickbooks/transactions.ts:209-216` asserts the live total against the
frozen snapshot before it will send a document. A sub-cent difference **blocks an
invoice** for a reason no one on the screen can see.

**Implemented fix.** `Math.round()` at each accumulation and on each header amount, so
the arithmetic is integers throughout, as it always claimed to be.

**Test coverage.** `tests/unit/version-totals-integer.test.ts` — 4 cases (integrality
from fractional legacy rows, exact integer arithmetic, discount clamped at subtotal,
standard freight only when ticked).

**Verification.** Tests written; **NOT RUN**.

**Confidence:** High.

---

### PROPOSAL-009 — Three independent implementations of the proposal total

**Status:** OPEN · **Severity:** MEDIUM · **Category:** Business logic / maintainability

**Location:** `public/app.js` `builderTotals()`; `src/proposals/analytics.ts`
`versionTotals()`; `src/pricing/engine.ts` `computePricing()`

**Problem.** The same rule exists three times. `versionTotals` is documented as
"mirrors the builder's math exactly" — a mirror maintained by hand. `pricing/engine.ts`
is the elaborate, bigint, fully-explained engine with its own unit tests, and **the
proposal path never calls it**; the discount, freight, tax and margin rules it encodes
are not the ones proposals actually use.

**Evidence.** `grep` for the totalling logic returns the three sites; no call path from
proposals or reports into `computePricing`.

**Real-world impact.** Any change to a money rule must be made in two places in agreement
and a third that nobody reads. The engine also creates a false sense of coverage: its
green tests say nothing about the numbers customers are quoted.

**Recommended fix (not implemented).** Either retire `pricing/engine.ts` from the
repository or migrate the proposal path onto it, then derive the browser's display total
from a server response instead of recomputing it. Both are behaviour-visible changes to
customer-facing money and need their own change window, staging validation and sign-off —
which is precisely why they were not attempted inside an audit that cannot run a test.

**Interim mitigation in place.** QuickBooks already refuses to transact when the live
total and the frozen snapshot disagree, which is what stops a divergence from reaching an
invoice.

**Confidence:** High.

---

### PROPOSAL-010 — Conflicts surface to users as server errors

**Status:** OPEN · **Severity:** MEDIUM · **Category:** Error handling / UX

**Location:** `src/plugins/error-handler.ts` (P2002 not translated); accept path in
`src/handoff/service.ts` (duplicate `proposalVersionId`)

**Problem.** Prisma unique-constraint violations are not mapped to a 409 with an
explanation. Accepting an already-accepted version, or any other legitimate collision,
reads to the user as "something broke".

**Real-world impact.** Support load, and — worse — a user retrying an operation that
actually already succeeded.

**Recommended fix (not implemented).** Translate P2002 in the error handler to a 409 with
the offending constraint named in business terms. Left open because it touches every
route's error surface and deserves its own test pass.

**Confidence:** Medium (error-handler internals were read only in outline).

---

### PROPOSAL-011 — DocuSeal webhook has no timestamp window

**Status:** ACCEPTED RISK · **Severity:** LOW · **Category:** Integration

**Location:** `src/routes/esignWebhook.ts`

**Problem.** The Resend webhook enforces a 5-minute freshness window
(`src/routes/webhooks.ts` `MAX_AGE_SECONDS`); the DocuSeal one does not, so a captured
request can be replayed.

**Why accepted.** The handler trusts nothing in the payload: it records the event and
then **re-reads envelope state from the DocuSeal API**. A replay therefore duplicates an
event row and repeats a read. Worth adding a window for symmetry; not worth a code change
without the ability to test the webhook end to end.

**Confidence:** High.

---

## 3. Checked and found clean

Recorded so the absence of a finding is not mistaken for an absence of review.

- **Webhook authentication.** Resend: Svix HMAC with a constant-time compare and a
  5-minute window. DocuSeal: shared secret or HMAC, constant-time, and state re-read
  from the API rather than trusted from the body. monday: signed-JWT verification.
- **QuickBooks duplicate prevention.** Idempotency keys on transactions
  (`idempotencyKey @unique`), a link table keyed `(environment, entity, entityId)`, and a
  live-total-vs-snapshot assertion before any document is created.
- **Content-Disposition construction.** `bomFilename()`
  (`src/handoff/bomDocuments.ts:501`) strips quotes, slashes and all whitespace including
  CR/LF — no header-injection path via customer or vendor names.
- **Password storage and reset.** argon2 hashing; reset tokens hashed at rest,
  single-use, and the forgot-password endpoint answers 204 uniformly (no enumeration
  oracle). Login refuses to reveal whether an account exists.
- **Environment handling.** `src/config/env.ts` validates with zod, treats blank as
  absent, trims pasted secrets, and refuses to boot on a half-configured financial
  integration. Production QuickBooks writes are gated behind an explicit flag.
- **Frozen-version immutability.** `updateVersionContent` and `renameProposalForVersion`
  both refuse a released or later version; the freight true-up path is the one narrow
  exception and is permission-gated separately.
- **CSP and security headers.** `@fastify/helmet` with an explicit `scriptSrc: 'self'`
  policy (no `unsafe-inline` for scripts).

---

## 4. Explicitly not audited

See `PRODUCTION_READINESS_REPORT.md` §4. In short: the catalog import and workbook
parsers, the rules engine, the Adventure/Soar configurators, the freight true-up service,
reporting aggregation, the Microsoft Graph/Outlook integration, the DocuSeal service
internals, the full Prisma schema (read selectively), migration history, and the browser
client beyond the flows traced. **No conclusion in this report covers those areas.**

# REMEDIATION_LOG.md

Every change made during the audit of 2026-08-17. Corrected files live under `fixes/`,
mirroring their repository paths — copy each one over the original.

**Nothing was compiled, linted or executed** (no shell in this environment). Run
`pnpm typecheck && pnpm lint && pnpm test:unit` after copying, before anything else.

---

## Files added

| Path                                            | Purpose                                                | Finding      |
| ----------------------------------------------- | ------------------------------------------------------ | ------------ |
| `src/proposals/validation.ts`                   | zod schemas for the builder's save shape               | PROPOSAL-001 |
| `src/lib/documentNumber.ts`                     | collision-safe document-number allocation              | PROPOSAL-002 |
| `src/lib/rateLimit.ts`                          | dependency-free fixed-window limiter                   | PROPOSAL-003 |
| `src/proposals/documentIntegrity.ts`            | server total vs client-rendered document               | PROPOSAL-007 |
| `src/crm/projectId.ts`                          | Project ID resolution (pre-audit fix, already in repo) | —            |
| `src/integrations/quickbooks/customerLookup.ts` | QuickBooks name matching (pre-audit fix)               | —            |

## Files changed

| Path                         | Change                                                                                  | Finding  |
| ---------------------------- | --------------------------------------------------------------------------------------- | -------- |
| `src/routes/proposals.ts`    | validate the PATCH body; forward `expectedUpdatedAt`; Project ID backfill on read       | 001, 005 |
| `src/proposals/service.ts`   | retrying number allocation; optimistic-concurrency precondition; Project ID at creation | 002, 005 |
| `src/handoff/service.ts`     | retrying order-number allocation                                                        | 002      |
| `src/routes/auth.ts`         | throttle login / forgot-password / reset-password                                       | 003      |
| `src/plugins/authz.ts`       | live account state; database role wins over the token's                                 | 004      |
| `src/approvals/service.ts`   | `requestVisibleTo()` authorisation helper                                               | 006      |
| `src/routes/approvals.ts`    | authorise `GET /approvals/:id`; 404 on no entitlement                                   | 006      |
| `src/routes/esign.ts`        | refuse a send whose document total ≠ the proposal's                                     | 007      |
| `src/routes/render.ts`       | same check on the monday PDF upload                                                     | 007      |
| `src/proposals/analytics.ts` | integer rounding at every money accumulation                                            | 008      |

## Tests added

| Path                                        | Cases | Finding |
| ------------------------------------------- | ----- | ------- |
| `tests/unit/proposals-validation.test.ts`   | 8     | 001     |
| `tests/unit/document-number.test.ts`        | 5     | 002     |
| `tests/unit/rate-limit.test.ts`             | 5     | 003     |
| `tests/unit/authz-live-account.test.ts`     | 5     | 004     |
| `tests/unit/document-integrity.test.ts`     | 7     | 007     |
| `tests/unit/version-totals-integer.test.ts` | 4     | 008     |

Total: 34 new cases. **All NOT RUN.**

---

## PROPOSAL-001 — unvalidated proposal content

**Root cause.** `POST /proposals` was given a zod schema; the `PATCH` that handles every
save afterwards was not, and an `as` cast hid the gap from the type checker.

**Before**

```ts
const body = req.body as {
  title?: string;
  sections?: ProposalSection[];
  items?: unknown[];
  orderedSectionIds?: string[];
  expirationDate?: string;
};
```

**After.** `VersionContentPatchSchema.safeParse(req.body ?? {})`, then
`assertMetaSectionsValid(body.sections)`; the first offending field is named in the 400.

**Design choices, and why.**

- Schemas `passthrough()` unknown keys. The builder carries fields the server has no
  opinion on (kit components, display flags, configurator bookkeeping); rejecting them
  would break every proposal saved by a client newer than the server, and stripping them
  would silently delete a rep's work.
- Money bound ±1e12 minor units — past any real gym, far under 2^53, which is what keeps
  the totals exact.
- Quantity 0 is legal (a note line, a line parked at nil); negative is not.
- Discount percentage bounded 0–100 so the stored value and the clamp inside
  `versionTotals` cannot disagree.

**Residual risk.** Documents already in the database were written without these rules. A
read-only sweep of `ProposalVersion.items` / `sections` against the schema before deploying
is the recommended pre-flight — if legacy rows fail, the next save of an untouched old
proposal will 400. That sweep needs a database: **NOT RUN.**

---

## PROPOSAL-002 — document-number collisions

**Root cause.** Read-then-write allocation against a unique column, no collision handling.

**After.** `allocateNumbered({ prefix, highest, create, format, field })` retries up to 6
times, re-reading the high-water mark each attempt. A P2002 on any other unique column is
rethrown, so a duplicate `proposalVersionId` on an accepted order still surfaces as "this
version is already accepted".

**Not done, deliberately.** No conversion to a Postgres sequence. The format restarts each
year, and the number appears on signed customer documents; changing its storage is a
migration with its own risk, not an audit patch.

---

## PROPOSAL-003 — unthrottled auth endpoints

**After.** Two buckets per attempt (IP and submitted address). Login 10/15 min, reset
request 5/hour, reset submission 20/hour, counters cleared on a successful sign-in, 429
carries `retryAfter`.

**Known limitation — must be read before believing the fix.** State is per process.
Serverless means the real ceiling is (limit × live instances) and cold starts forget.
Attack rate is materially reduced; it is not bounded. No dependency was added because the
lockfile cannot be resolved in this environment.

**Follow-up (required for the durable fix).** Either add `@fastify/rate-limit` with a
Postgres/Redis store, or apply a platform/edge rule on `/auth/*`. Then this module becomes
a second layer rather than the only one.

---

## PROPOSAL-004 — stale authority in stateless tokens

**Root cause.** Signature verification treated as authorisation; the token's `role` claim
treated as current.

**After.** `requireAuth` resolves `{ isActive, role }` from the `User` row (5-second
in-process cache), refuses inactive and unknown users, and attaches the **database** role.
A token minted before a demotion cannot spend the old authority.

**Cost.** ~1 indexed lookup per user per 5 s. Set `CACHE_MS = 0` if immediate revocation
matters more than the query.

**Follow-up.** Deactivation should also call `revokeAllForUser` if it does not already
(the admin route was not audited); that kills the refresh session as well as the access
window.

---

## PROPOSAL-005 — lost updates on concurrent saves

**After (server).** `updateVersionContent(versionId, content, userId, { expectedUpdatedAt })`
refuses a stale save with a 409 and a plain message. Tolerance 1 s, because JSON
round-trips lose sub-second precision on some clients and a false conflict is its own kind
of lost work.

**Follow-up — REQUIRED, the fix is inert without it.** `public/app.js` must:

1. record `version.updatedAt` when the builder opens and after every successful save;
2. send it as `expectedUpdatedAt` on each save;
3. on a 409, show the message and offer a reload rather than retrying.

Not done here: that file is one 12,681-line script and this project's rules require
whole-file delivery. Shipping an unreviewable rewrite of the entire client to add three
lines is a larger risk than the defect.

---

## PROPOSAL-006 — approval-request disclosure

**After.** `requestVisibleTo(requestId, ctx)` in `src/approvals/service.ts` reuses
`canDecide()` — the same guard as the queue and the decision endpoints — and the route
returns 404 when the caller is not entitled, so the id is not confirmed.

**Follow-up.** Add an integration test alongside `tests/integration/approvals-routes.test.ts`
asserting a READ_ONLY caller gets 404 for another user's request, and the requester gets 200. Needs the test database: **NOT RUN.**

---

## PROPOSAL-007 — unverified client-rendered documents

**After.** `checkDocumentTotal(html, items, sections)` computes the total server-side and
requires it to appear in the submitted document. Both send paths refuse a mismatch with
"…its total should be X. Reload the proposal…".

**Tolerances.** Matches the figure with or without thousands separators and across markup
splits (`<b>5,125</b>.50`), because a false refusal would block a legitimate send. Zero
totals are exempt — a specification sheet is a legitimate document and "0.00" appears too
often to mean anything.

**Verify before deploying.** Run one staging e-sign send and one monday upload with a real
proposal and confirm both pass. If a template formats the total unusually, widen the
matcher rather than removing the check. **NOT RUN here** (no running app).

**Not attempted.** Server-side rendering of the proposal from stored state, which is the
only complete answer. It is a project with its own design and sign-off.

---

## PROPOSAL-008 — float money accumulation

**After.** `Math.round()` at each accumulation and on each header amount in
`versionTotals`. Behaviour on clean integer data is unchanged (proved by the exact-values
test); legacy fractional rows now produce whole cents instead of a residue that blocks a
QuickBooks document.

---

## Not changed, and why

| Finding                                     | Reason                                                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROPOSAL-009 (three totals implementations) | Behaviour-visible change to customer-facing money. Needs a change window, staging validation and sign-off — not an audit patch. QuickBooks' snapshot assertion already blocks a divergence from reaching an invoice. |
| PROPOSAL-010 (P2002 → 500)                  | Touches every route's error surface; deserves its own test pass.                                                                                                                                                     |
| PROPOSAL-011 (DocuSeal replay window)       | Payload is never trusted as state; the handler re-reads from the API. Symmetry with the Resend webhook is worth having, but not without an end-to-end test.                                                          |
| Dependency upgrades                         | No registry access and no ability to run the suite afterwards. An unverified upgrade of the auth, PDF or ORM libraries is a worse risk than the warnings it silences.                                                |
| Database migrations                         | No database. No schema change was needed for any fix above — deliberately, so the whole remediation is a code-only deploy with an obvious rollback (restore the previous files).                                     |

---

## Rollback

Every change is file-level and additive or local. To revert: restore the ten changed files
from git and delete the four added modules plus the six test files. No migration ran, no
data was touched, and no stored format changed.

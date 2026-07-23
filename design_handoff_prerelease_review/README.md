# Handoff: Pre-Release Security & Quality Review — Summit Sensory Gym CPQ

## Purpose of this package
This is an **instruction spec for Claude Code**, not a UI design bundle. It directs a comprehensive
pre-release security and quality review of the Summit Sensory Gym CPQ application (Milestones 1–14:
auth/roles, catalog + configuration rules, proposals with versions + price snapshots + PDF, QBO
integration, monday.com integration, accepted-order/handoff lock, reporting/metric dictionary, data
import + historical/pricing reconciliation). Run this review against the real repository — read the
actual code, do not assume behavior.

**Governing rule:** while any RELEASE BLOCKER remains open, Claude Code must NOT describe the
application as production-ready, "shippable", or "cleared for release" — in any file, comment, commit
message, or summary. State the release status as **BLOCKED** until blockers are resolved and re-verified.

---

## How to run the review (method)
1. **Map the codebase first.** Enumerate routes, middleware, Prisma models, background jobs,
   integration clients (QBO/monday), webhook handlers, PDF generation, import pipeline, and the React
   frontend. Produce an inventory before judging.
2. **Evidence-based findings only.** Every finding cites file + line (or route/model) and a concrete
   reproduction or code path. No generic "you should validate input" — point at the unvalidated input.
3. **Severity model** (use consistently across all docs):
   - **Critical** — exploitable now, causes data breach / financial loss / auth bypass / silent data
     corruption. RELEASE BLOCKER.
   - **High** — serious weakness, exploitable with modest effort or high impact if triggered. RELEASE
     BLOCKER unless explicitly risk-accepted by the user.
   - **Medium** — real issue, limited impact or needs unusual conditions. Fix soon, not a blocker.
   - **Low / Informational** — hardening, defense-in-depth, nits.
4. **Fix Critical + High now.** For every Critical and High finding, implement the correction in the
   codebase, add/extend a regression test that fails before and passes after, and record it in the
   register with a "Fixed in" reference. Medium/Low go to the remediation plan.
5. **Re-verify.** After fixes, re-run the affected checks and `pnpm check && pnpm test`. A blocker is
   only closed when a test proves it.

---

## Security review scope → what to check for each
Write findings into `SECURITY_REVIEW.md`, grouped by area. For each area, the minimum checks:

- **Authentication** — password/credential handling, hashing (argon2/bcrypt, cost), token issuance +
  expiry, refresh handling, brute-force protection, account enumeration on login/reset.
- **Authorization** — every route checks a permission; no route relies on UI hiding; server-side
  enforcement of `orders:*`, `handoff:*`, `reports:*`, `import:*`; IDOR on `:id` params (can user A
  read user B's proposal/order?).
- **Role permissions** — role→permission map matches intended matrix; no over-grant; privilege
  escalation via role assignment endpoints.
- **Data exposure** — API responses don't leak fields the role shouldn't see; list endpoints scoped
  by owner; no cost/margin/discount/deposit fields returned to non-financial roles.
- **Cost & margin protection** — cost, margin, discount, deposit, collected amounts gated by
  `reports:financials`-equivalent everywhere (API, export, drilldown, PDF, import). This is a
  business-critical confidentiality boundary — treat leaks here as Critical/High.
- **Input validation** — all bodies/params/queries validated (schema, types, ranges); numeric money
  fields are integer cents, non-negative where required; enums constrained.
- **File uploads** (import sources, documents) — content-type + extension + size limits, checksum,
  storage outside webroot, no path traversal in filenames, no execution, virus/again-parse safety,
  CSV formula-injection neutralized on export.
- **Injection** — Prisma parameterization everywhere; no raw string SQL; no `$queryRawUnsafe` with
  interpolation; NoSQL/command injection in any shell-outs.
- **XSS** — React escaping intact; no `dangerouslySetInnerHTML` with untrusted data; PDF/template
  rendering escapes user content; stored proposal text rendered safely.
- **CSRF** — state-changing routes protected (same-site cookies + token, or bearer-only with no
  ambient cookie auth); verify the actual scheme, not the assumed one.
- **Session handling** — cookie flags (HttpOnly, Secure, SameSite), session fixation, logout
  invalidation, idle + absolute timeout, token revocation.
- **Secret management** — no secrets in repo/history; QBO/monday keys + QBO-token encryption key from
  env/secret store; encryption at rest for stored OAuth tokens; key rotation story.
- **Logging** — no secrets/PII/tokens/full card or bank data in logs; audit logs distinct from debug
  logs; log level appropriate; correlation ids.
- **Error messages** — no stack traces / SQL / internal paths returned to clients; generic client
  errors, detailed server-side.
- **Dependency vulnerabilities** — run `pnpm audit`; list known CVEs with severity + fixed version;
  flag unmaintained/critical deps.
- **API security** — consistent authz, method restrictions, content-type enforcement, pagination
  bounds, mass-assignment protection on writes.
- **Webhook validation** — QBO/monday inbound webhooks verify signatures/verifier tokens, reject
  replay (timestamp/nonce), and are idempotent; no trust of unauthenticated webhook payloads.
- **Rate limiting** — auth endpoints, export endpoints, import uploads, integration retry endpoints
  are rate-limited; brute-force + abuse protection.
- **Database constraints** — NOT NULL, unique keys on natural/source keys, FK integrity, check
  constraints on money/enum fields, no orphan sub-records; migrations enforce them (not just app code).
- **Financial transaction safety** — money as integer cents; multi-step financial ops (order lock,
  deposit invoice, reconciliation approval) are transactional + idempotent; no lost updates; QBO/monday
  writes idempotent with stored external ids.
- **Duplicate prevention** — one accepted order per proposal; import source-hash + source-key dedupe;
  idempotent webhook + integration calls; unique constraints back the app-level guards.
- **Backup & recovery** — DB backup cadence + PITR documented; restore tested; migration rollback plan;
  uploaded-file store backup.
- **Audit integrity** — `OrderEvent` (and any audit log) is append-only at the DB level (no update/
  delete grants / enforced in code + reviewed); integrity hash verification path works; tampering
  detectable.
- **Personal-data handling** — PII inventory (contacts, orgs, users); access controls; retention +
  deletion policy; anonymization used for pricing tests actually removes PII; export/portability;
  minimize PII in analytics/logs.

## Quality review scope → `QUALITY_REVIEW.md`
- **Pricing accuracy** — engine matches the metric dictionary + reconciliation results; rounding
  rules consistent (cents, half-up documented); price-list/cost effective-date selection correct.
- **Configuration-rule accuracy** — product configuration/compatibility rules enforce valid combos;
  invalid configs rejected; included/excluded item logic correct.
- **Proposal version integrity** — new versions never mutate prior versions or their price snapshots;
  accepted-order snapshot immutable; drift detection works.
- **PDF accuracy** — generated PDF matches the proposal version + price snapshot exactly (totals,
  line items, discounts, terms); no stale data; correct version rendered; financial fields respect role
  where PDFs are shared.
- **Integration reliability** — QBO/monday retry, backoff, idempotency, failure events, and the
  retry endpoint behave correctly; partial-failure handling; no duplicate external records.
- **Accessibility** — WCAG 2.1 AA pass on key screens: keyboard nav, focus order, labels/ARIA,
  contrast, error announcement; run axe + manual keyboard test.
- **Mobile responsiveness** — key flows usable at mobile widths; hit targets ≥44px; no horizontal
  scroll/overflow; tables/reports degrade gracefully.
- **Performance** — N+1 query audit (report + list endpoints), indexes on filtered/joined columns,
  pagination, PDF/report generation time, large-import throughput, payload sizes.
- **Error recovery** — transactions roll back cleanly on failure; interrupted imports/integrations
  resumable; user-facing error states; no partial writes left behind.

---

## Required deliverables (exact filenames, at repo root or `/docs`)
1. **SECURITY_REVIEW.md** — full narrative by area above; each area: what was checked, findings with
   severity + file/line + evidence, and status (open/fixed). Include the codebase inventory and the
   `pnpm audit` summary.
2. **QUALITY_REVIEW.md** — same structure for the quality areas, with test evidence for pricing/
   version/PDF/integration accuracy and axe/perf results.
3. **VULNERABILITY_REGISTER.md** — table, one row per finding: `ID | Title | Category | Severity |
   CVSS-ish | Location | Status (Open/Fixed/Risk-Accepted) | Fixed-in (commit/PR) | Regression test`.
   Stable IDs (e.g. SSG-SEC-001). This is the single source of truth for counts.
4. **REMEDIATION_PLAN.md** — every non-fixed finding with owner, recommended fix, effort estimate,
   priority, and target milestone; grouped Critical→Low; Critical/High marked as already fixed link to
   the register.
5. **RELEASE_BLOCKERS.md** — the gate. Lists every Critical + High (and any risk item the user must
   sign off). For each: why it blocks, current status, what closes it, and the verifying test. Top of
   file states overall **RELEASE STATUS: BLOCKED / CLEARED** — and it may only read CLEARED when the
   list is empty (or every item is explicitly user-risk-accepted with a recorded note). Keep it BLOCKED
   otherwise.

Cross-link the docs by finding ID so counts reconcile across all five.

---

## Fix-now workflow (Critical + High)
For each Critical/High:
1. Write a failing regression test capturing the vuln/defect.
2. Implement the fix using the repo's existing patterns.
3. Confirm the test passes and `pnpm check && pnpm test` are green.
4. Update the register (Status: Fixed, Fixed-in, test name), SECURITY/QUALITY_REVIEW status, and move
   the item in RELEASE_BLOCKERS to resolved-pending-final-verify.
5. Only mark a blocker fully closed after a clean full-suite run.

## Acceptance criteria
- All 23 security areas and 9 quality areas reviewed with evidence-based findings.
- All five documents produced, internally consistent, and cross-linked by finding ID.
- Every Critical and High finding is fixed with a regression test, or explicitly risk-accepted by the
  user in writing.
- `pnpm check && pnpm test` pass, including new regression tests.
- No document, comment, or summary calls the app production-ready while RELEASE_BLOCKERS is not CLEARED.

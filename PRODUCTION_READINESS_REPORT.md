# PRODUCTION_READINESS_REPORT.md

Subject: Summit Sensory Gym Proposal Builder (`SummitSensory/SSG-CPQ-App`)
Date: 2026-08-17
Basis: code-level adversarial audit + implemented remediation (`fixes/`), **no executed checks**

---

## 1. Verdict

**NOT production-ready as verified. Score: 58 / 100.**

Read that as a statement about _verification_, not a claim that the application is broken.
It plainly works — it is in daily use. But this audit could not run a build, a type check,
a lint, a test, a migration check, a dependency scan, or a single live request, because the
environment has no shell, no database and no git. Ten files were corrected and 34 regression
cases written; **none of it has been compiled or executed.** A production verdict cannot be
issued on unexecuted code, and inflating the score on the strength of a code review would be
the exact failure this audit was commissioned to prevent.

The path to a defensible "ready" is short and concrete — §5.

---

## 2. Scoring

| Area                                    | Weight  | Score   | Deductions                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security and authorization              | 25      | 14 / 25 | −4 rate limiting is per-process only on a serverless host (PROPOSAL-003, partial); −3 approval-request IDOR fixed but untested at runtime (006); −2 stale-authority fix untested (004); −2 no live cross-account probing performed (Phase 5 NOT RUN)           |
| Data integrity and calculation accuracy | 20      | 11 / 20 | −4 the main write path was unvalidated until now and legacy rows have never been checked against the new schema (001); −3 lost-update protection inert until the client sends the precondition (005); −2 three independent totals implementations remain (009) |
| Functional reliability                  | 20      | 12 / 20 | −4 no workflow executed end to end in this audit; −2 numbering collisions fixed but untested (002); −2 conflicts still surface as 500s (010)                                                                                                                   |
| Automated testing                       | 15      | 7 / 15  | −5 nothing was run; −3 no integration coverage added for the two authorization fixes                                                                                                                                                                           |
| Deployment and observability            | 10      | 5 / 10  | −2 no error-monitoring service or alerting; −1 no health/backup verification possible; −2 migration status unknown (NOT RUN)                                                                                                                                   |
| Maintainability and scalability         | 10      | 9 / 10  | −1 duplicated business logic (009); a 12,681-line unbundled client is a genuine constraint on safe change                                                                                                                                                      |
| **Total**                               | **100** | **58**  |                                                                                                                                                                                                                                                                |

For context: had the same code passed a full green run of build, typecheck, lint, unit,
integration and e2e, plus a live isolation probe, the same findings would score in the low
80s. The gap is verification, not defects.

---

## 3. Findings summary

| ID           | Severity | Status          | Title                                                         |
| ------------ | -------- | --------------- | ------------------------------------------------------------- |
| PROPOSAL-001 | CRITICAL | FIXED           | Proposal content written with no server-side validation       |
| PROPOSAL-002 | HIGH     | FIXED           | Concurrent creates collide on document numbers (500)          |
| PROPOSAL-003 | HIGH     | PARTIALLY FIXED | No rate limiting on any auth endpoint                         |
| PROPOSAL-004 | HIGH     | FIXED           | Deactivated/demoted users keep authority for the token's life |
| PROPOSAL-005 | HIGH     | PARTIALLY FIXED | Concurrent draft edits overwrite each other silently          |
| PROPOSAL-006 | HIGH     | FIXED           | Any authenticated user can read any approval request          |
| PROPOSAL-007 | HIGH     | PARTIALLY FIXED | Signed contract built from unchecked client HTML              |
| PROPOSAL-008 | MEDIUM   | FIXED           | Proposal money accumulated in floating point                  |
| PROPOSAL-009 | MEDIUM   | OPEN            | Three independent implementations of the proposal total       |
| PROPOSAL-010 | MEDIUM   | OPEN            | Constraint conflicts surface to users as 500s                 |
| PROPOSAL-011 | LOW      | ACCEPTED RISK   | DocuSeal webhook has no replay window                         |

No CRITICAL finding is left open. Three HIGH findings are partial, each for a stated
reason, each with the completing step named.

---

## 4. Unresolved risks and unaudited surface

**Unresolved (documented, with owners implied):**

1. Rate limiting is not globally bounded on serverless — needs a shared store or an edge rule.
2. Lost-update protection needs three lines in `public/app.js` before it does anything.
3. Document verification covers the bottom line only; the rest of the signed document is
   still whatever the client posted.
4. Money rules live in three places; the browser's total is not derived from the server's.
5. No error monitoring, no alerting, no verified backup/restore procedure.

**Not audited at all — no conclusion in these reports covers them:**
catalog import and workbook parsers (`src/catalog/*`), the rules engine (`src/rules/*`),
the Adventure and Soar configurators, freight true-up (`src/proposals/freightTrueUp*`),
reporting aggregation beyond `versionTotals`, Microsoft Graph / Outlook drafts, DocuSeal
service internals, the full Prisma schema and its migration history, the e2e suite, and
`public/app.js` beyond the flows traced (roughly 5% of it).

**Phases that could not be performed:** Phase 0 (git baseline), Phase 5 (live
data-isolation probing), Phase 14 (dependency scan), Phase 15 (static analysis /
automated checks), Phase 17 in its runtime form (adversarial requests), Phase 18
(performance at scale), Phase 19 (operational controls: backups, restore, alerting).

---

## 5. What "ready" requires

In order. Steps 1–4 are mechanical and should take under a day.

1. Copy `fixes/` over the repository, preserving paths.
2. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` — fix
   anything the compiler or the new tests report. (Expect small mechanical corrections:
   this code was written without a compiler in the loop.)
3. `pnpm db:migrate:status` — confirm no drift. No migration is needed for these fixes.
4. Run a read-only sweep of `ProposalVersion.items` / `sections` against
   `BuilderLineSchema` / `BuilderMetaSchema` and report failures. Legacy rows that fail
   will 400 on their next save; widen the schema or clean the data before deploying.
5. On staging: one e-sign send and one monday PDF upload with a real proposal, to prove
   PROPOSAL-007's check does not refuse a legitimate document.
6. On staging: sign in as READ_ONLY and `GET /approvals/<another user's request>` — expect 404. Deactivate a signed-in user and confirm their next request 401s inside 5 seconds.
7. Add the integration tests named in `REMEDIATION_LOG.md` (approval visibility, save
   precondition 409).
8. Wire `expectedUpdatedAt` into `public/app.js` (PROPOSAL-005) — the one client change
   this audit deliberately did not make.
9. Put rate limiting behind a shared store or an edge rule (PROPOSAL-003).
10. Add error monitoring and an alert on 5xx rate and on failed integration pushes.

With 1–7 green and 8–10 scheduled, the score moves to the low 80s and a production
deployment is defensible. Until step 2 has actually been run, it is not.

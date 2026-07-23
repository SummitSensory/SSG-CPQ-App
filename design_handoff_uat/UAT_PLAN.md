# UAT_PLAN.md — Summit Sensory Gym CPQ

## 1. Purpose & scope
Formal user-acceptance testing to confirm the CPQ application meets business requirements across the
full quote-to-handoff lifecycle before release. In scope: the 26 scenarios in `UAT_TEST_CASES.md`
covering customer/opportunity setup, product configuration + rules, pricing/discount/tax/logistics,
proposals + versions + approval + acceptance, QBO/monday integrations + failure handling, duplicate
prevention, permissions, and mobile use. Out of scope: unit/security testing (covered by prior
milestones), load/performance testing (separate effort).

## 2. Roles
- **UAT Coordinator** (Claude Cowork) — schedules, tracks, triages defects, routes to Claude Code.
- **Business testers** — execute cases in their real role: Sales Rep, Sales Manager, Ops, PM,
  Installer, Accounting, Exec. Each case names the required role.
- **Developer** (Claude Code) — resolves routed defects, one bounded prompt at a time, with regression
  tests.
- **Product owner** — approves the final release recommendation.

## 3. Environment
- Dedicated UAT deployment against a UAT Postgres DB (isolated from prod), seeded with a known
  reference dataset (catalog + configuration rules + price lists + costs + tax rules + a set of test
  users, one per role).
- QuickBooks **sandbox** company and monday.com **test board** connected; sandbox credentials in the
  UAT secret store.
- Test data reset script available so cycles start from a clean baseline.

## 4. Entry criteria (must be true before UAT begins)
- Pre-release security/quality review complete; RELEASE_BLOCKERS = CLEARED (no open Critical/High from
  that review).
- UAT build deployed; smoke test of login + each integration connection passes.
- Reference dataset + role users seeded; QBO sandbox + monday test board reachable.
- `UAT_TEST_CASES.md` reviewed and accepted by the product owner.

## 5. Exit criteria (must be true to finish UAT)
- 100% of test cases executed.
- ≥95% of cases Passed on final cycle.
- **Zero open Critical or High defects.**
- All Medium defects triaged with an agreed disposition (fix-now or deferred-with-signoff).
- Every fixed defect has a passing retest recorded in `UAT_RESULTS.md`.

## 6. Severity definitions (defects)
- **Critical** — blocks a core business flow, causes financial error, data loss/corruption, wrong
  price/total, integrity/permission breach. Release blocker.
- **High** — major function broken with no reasonable workaround; wrong-but-recoverable financial
  display. Release blocker.
- **Medium** — function impaired with a workaround; non-financial inaccuracy.
- **Low** — cosmetic, copy, minor UX.

## 7. Defect lifecycle
`New → Triaged → (Routed to Claude Code) → Fixed → Retest → Closed | Reopened | Deferred(with signoff)`.
Only reproduced, verified coding defects are routed. Test-data/environment issues are corrected in the
harness, not routed.

## 8. Defect routing to Claude Code (one at a time)
The coordinator sends a single bounded prompt per defect (template in `DEFECT_REGISTER.md`): defect id,
linked Test ID, exact repro steps, expected vs actual, evidence, and the constraint "fix only this
defect; add a regression test; do not change unrelated behavior." Wait for the fix + green tests before
routing the next. This keeps changes reviewable and prevents scope creep.

## 9. Cycles & schedule
Cycle 1: full execution. Cycle 2+: retest failed/blocked cases after fixes land. Repeat until exit
criteria met. Record each cycle in `UAT_RESULTS.md`.

## 10. Deliverables
`UAT_PLAN.md`, `UAT_TEST_CASES.md`, `UAT_RESULTS.md`, `DEFECT_REGISTER.md`, `RELEASE_RECOMMENDATION.md`.

# DEFECT_REGISTER.md — Summit Sensory Gym CPQ

Single source of truth for UAT defects. Only reproduced, verified coding defects are routed to Claude
Code — **one bounded prompt at a time**. Environment/test-data issues are fixed in the harness, not
routed (note them under "Non-defects").

## Severity
Critical / High = release blockers. Medium = fix-or-defer-with-signoff. Low = cosmetic.

## Register
| Defect ID | Title | Linked Test ID | Severity | Status | Routed to CC? | Fixed in (ref) | Retest result | Evidence |
|---|---|---|---|---|---|---|---|---|
| DEF-001 | | | | New | No | | | |

Status values: `New → Triaged → Routed → Fixed → Retest → Closed | Reopened | Deferred(signoff)`.

## Claude Code defect-resolution prompt template (send ONE at a time)
> **Fix defect {DEF-ID} only.**
> Context: Summit Sensory Gym CPQ, milestone code already in the repo.
> Linked UAT case: {Test ID} — {case name}.
> Repro steps: {exact steps}.
> Expected: {expected result}. Actual: {actual result}.
> Evidence: {screenshot / log excerpt / QBO or monday record}.
> Constraints: fix only this defect; add a regression test that fails before and passes after;
> do not change unrelated behavior; run `pnpm check && pnpm test` and report results.
> When done, report: root cause, files changed, the new test name, and suite status.

Do not send the next defect until the current one is Fixed with green tests and the linked UAT case is
retested.

## Routing queue (ordered; work top-down, one active at a time)
| Order | Defect ID | Severity | Active? |
|---|---|---|---|
| 1 | | | |

## Non-defects (environment / test-data issues, not routed)
| Note ID | Description | Resolution |
|---|---|---|
| | | |

# UAT Coordination — Summit Sensory Gym CPQ

## Purpose
This folder is the coordination package for **formal User Acceptance Testing** of the Summit Sensory
Gym CPQ application (Milestones 1–15). It is authored to be driven by a coordinator (Claude Cowork)
who runs testers through the cases, records results, and routes verified coding defects to Claude Code
**one bounded defect-resolution prompt at a time**.

Deliverables in this folder:
- `UAT_PLAN.md` — scope, roles, environment, entry/exit criteria, schedule, defect + release process.
- `UAT_TEST_CASES.md` — all 26 scenarios as formal cases with the required fields.
- `UAT_RESULTS.md` — execution log (actual result / pass-fail / evidence per case per cycle).
- `DEFECT_REGISTER.md` — every defect: id, severity, linked test, status, Claude Code routing state.
- `RELEASE_RECOMMENDATION.md` — the gate; go / no-go tied to exit criteria and open defects.

## Coordination workflow (Claude Cowork)
1. Confirm the UAT environment is seeded and healthy (see UAT_PLAN entry criteria).
2. Assign each case to a tester with the correct role. Testers execute steps, fill **Actual result**,
   **Pass/Fail**, and attach **Evidence**.
3. For each FAIL: reproduce, confirm it is a genuine defect (not test-data/environment error), and log
   it in DEFECT_REGISTER with severity + linked Test ID + evidence.
4. **Route to Claude Code one at a time.** Only verified coding defects are routed. Send a single
   bounded defect-resolution prompt (template in DEFECT_REGISTER), wait for the fix + regression test,
   re-run the failed case, mark Retest result. Do not batch multiple defects into one prompt.
5. When all cases are executed and exit criteria evaluated, write RELEASE_RECOMMENDATION. It may only
   recommend GO when exit criteria are met and no Critical/High defect remains open.

**Rule:** do not declare UAT passed or the app release-ready while any Critical or High defect is open.

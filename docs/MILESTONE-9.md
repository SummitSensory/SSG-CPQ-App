# Milestone 9 — Internal Approval Workflow

## Status
Scaffold authored on top of Milestones 1–8. **Not executed** here (no terminal/DB). Apply migration `0009_approvals`; run `pnpm check` and `pnpm test`.

## Approval types (10)
DISCOUNT, MARGIN_EXCEPTION, CUSTOM_PRICING, CUSTOM_PRODUCT, PRODUCT_RULE_OVERRIDE, FREIGHT_EXCEPTION, INSTALLATION_EXCEPTION, LEGAL_EXCEPTION, PAYMENT_TERM_EXCEPTION, PROPOSAL_RELEASE. Each maps to an approver permission in `src/approvals/policy.ts`.

## Record kept per approval (`ApprovalRequest`)
Requester (`requesterId`), approver (`approverId`), reason, supporting info (`supportingInfo` JSON), original value, requested value, decision, decision notes, decided-at timestamp, linked proposal + version (`proposalId`/`proposalVersion`), and an append-only `ApprovalEvent` trail plus `recordAudit` audit events.

## Features → implementation
| Feature | Where |
|---|---|
| Approval queues | `queueFor` + `GET /approvals/queue` (only requests the user may act on) |
| Notifications | `src/approvals/notify.ts` (swappable Notifier; logs by default) |
| Delegated approval | `ApprovalDelegation` + `activeDelegateIds` + `POST /approvals/delegations` |
| Rejection | `reject` + `POST /approvals/:id/reject` |
| Revision request | `requestRevision` (notes required) |
| Escalation | `escalate` + `escalatedToId` |
| Expiration | `expiresAt` + `expireOverdue` sweep |
| Separation of duties | `SELF_APPROVAL_PROHIBITED` + `canDecide` |
| Prevent self-approval | `canDecide` blocks requester==decider where prohibited (even for delegates) |

## Authority model
Every endpoint requires authentication; the *decision* authority is enforced in the service via `canDecide`, which checks: (1) the decider holds the type's approver permission OR is an active delegate, AND (2) the decider is not the requester when self-approval is prohibited. This holds even if a prohibited requester happens to be a delegate.

## Tests
- `tests/unit/approvals-policy.test.ts` — self-approval blocked where prohibited; allowed where not; no-permission blocked; delegate allowed; delegate-who-is-requester still blocked; authorized third party allowed; every type maps to a real permission.
- `tests/integration/approvals-routes.test.ts` — unauthenticated create/queue 401; body validation 400; revision requires notes; escalate requires target.

## Not tested / out of scope
- DB-backed decision transactions, queue filtering against live rows, delegation windows, and the expiry sweep need a test DB — the permission/SoD logic is fully covered by the pure `canDecide` unit tests.
- Threshold *detection* (what discount % or margin triggers an approval) is produced by the pricing engine (Milestone 7, `REQUIRE_APPROVAL` findings); this milestone consumes that signal and manages the human decision.
- Real notification transport (email/monday/in-app) — the Notifier interface is ready; default logs.
- Nothing was executed in this environment.

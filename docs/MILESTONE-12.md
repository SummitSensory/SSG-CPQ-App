# Milestone 12 — Accepted Proposal & Operational Handoff

## Status
Scaffold authored. Apply migration `0012_accepted_orders`; run `pnpm check` and
`pnpm test`. Full design in `docs/HANDOFF.md`.

## Deliverables
- **Accepted-proposal lock** with an immutable, version-anchored operational order.
- **Handoff scaffold** (requirements, procurement, tasks) seeded on acceptance.
- **Audit history + handoff-status reporting** endpoints.
- **Tests:** `tests/unit/handoff-lock.test.ts`, `tests/integration/handoff-service.test.ts`, `tests/integration/orders-authz.test.ts`.

## Files
| Concern | File |
|---|---|
| Schema (order, approval, requirements, procurement, tasks, events) | `prisma/schema.prisma`, migration `0012_accepted_orders` |
| Pure lock helpers (snapshot, integrity hash, seeds) | `src/handoff/lock.ts` |
| Service (accept-lock, CRUD, integrity, reporting) | `src/handoff/service.ts` |
| Routes | `src/routes/orders.ts` (+ `src/app.ts`) |
| Permissions | `src/authz/permissions.ts` (`orders:read`, `orders:manage`, `handoff:manage`) |

## Requirement compliance
- **Accepted proposal lock** — `AcceptedOrder` (frozen `contentSnapshot`, `locked`, `integrityHash`); `proposalVersionId` unique.
- **References exact accepted version + pricing snapshot** — `proposalVersionId` + `priceSnapshotId` stored and snapshotted.
- **No later edit silently alters the order** — order never reads the live proposal for money/scope; edits require a new version; `verifyIntegrity` detects drift.
- **Customer approval record** — `CustomerApproval` (method, approver, PO#, signed-at, document ref, recorded-by).
- **Deposit requirement** — `depositRequired` + `depositDueMinor` from the frozen payment schedule.
- **QuickBooks action / monday project** — seeded tasks + `qboEstimateTxnId` / `mondayProjectId` links (executed by Milestones 10–11).
- **Procurement list** — `ProcurementLine[]` seeded from accepted INCLUDED items.
- **Production / custom-product / shipping / installation / training / customer-responsibility / facility-access / required-document** — `HandoffRequirement` categories.
- **Internal task assignment + target dates** — `HandoffTask` (assignee + `dueDate`); `targetDate` on requirements/procurement.
- **Exception flags** — `isException` + required `exceptionReason` on requirement/task/procurement.
- **Complete audit history** — append-only `OrderEvent` timeline + global `AuditLog`; `GET /orders/:id/audit`.
- **Handoff-status reporting** — `GET /orders/:id/status` (rollups, exceptions, deposit, integrations, integrity).

## Follow-ups
1. Wire the "Create QuickBooks deposit invoice" task to Milestone 11 `prepareTransaction(DEPOSIT_INVOICE)` and store the id via `POST /orders/:id/integrations`.
2. Wire the "Create/update monday.com project" task to the Projects board push and store `mondayProjectId`.
3. Optional: auto-invoke `createAcceptedOrder` from the proposal `accept` route once the customer-approval capture UI exists (kept explicit for now so the approval record is always captured).

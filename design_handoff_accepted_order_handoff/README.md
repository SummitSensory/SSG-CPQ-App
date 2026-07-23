# Handoff: Accepted Proposal & Operational Handoff Milestone

## Purpose of this package
This is an **implementation spec for Claude Code**, not a UI design bundle. It describes a
backend milestone to add to the existing proposal/CRM codebase (the one already carrying
Milestones 1–11: auth/roles, catalog, proposals with versions + price snapshots, QuickBooks
Online integration, and monday.com integration). Hand this folder to Claude Code and instruct it
to implement the milestone against the repo's established stack (Prisma + Postgres, TypeScript route
layer, existing authz middleware, existing QBO and monday clients).

If any assumption below conflicts with the real repo, prefer the repo's existing conventions and
note the deviation.

---

## Goal
When a proposal is **accepted**, create an immutable **AcceptedOrder** that pins the exact accepted
proposal version and price snapshot, and generate a complete operational handoff record (approvals,
deposit, procurement, requirements across every category, internal tasks, documents) plus a full
audit trail and status reporting.

**Hard invariant:** later edits to a proposal (which happen only by creating new versions) must
**never** silently alter an accepted order. The accepted order stores frozen snapshots and an
integrity hash; drift is detectable, never absorbed.

---

## Data model (Prisma)
Add these models in a new migration `0012_accepted_orders`. Names are guidance; align types/enums
with existing schema conventions (cuid ids, `createdAt/updatedAt`, soft-delete pattern if used).

### AcceptedOrder (the lock)
- `id`
- `proposalId` → Proposal
- `proposalVersionId` → the EXACT accepted ProposalVersion (immutable ref)
- `priceSnapshotId` → the EXACT PriceSnapshot used at acceptance (immutable ref)
- `contentSnapshot` Json — full frozen copy of the accepted proposal content (line items,
  descriptions, quantities, unit prices, totals, terms) as it existed at acceptance
- `integrityHash` String — SHA-256 over a canonical serialization of
  `{proposalVersionId, priceSnapshotId, contentSnapshot}`
- `status` enum `OrderStatus` — `ACCEPTED | IN_HANDOFF | IN_PRODUCTION | FULFILLED | CANCELLED`
- `acceptedAt`, `acceptedByUserId`
- `qboEstimateId` String? — set when the QBO action completes (Milestone 10 call)
- `mondayProjectId` String? — set when the monday project is created/updated (Milestone 11 call)
- relations: `approval`, `depositRequirement`, `procurementLines[]`, `handoffRequirements[]`,
  `handoffTasks[]`, `documents[]`, `events[]`

### CustomerApproval
- `id`, `acceptedOrderId` (unique — one per order)
- `approvedAt`, `authorizedByName`, `authorizedByTitle`, `authorizationMethod`
  (enum: `SIGNATURE | EMAIL | VERBAL | PORTAL`), `notes`

### DepositRequirement
- `id`, `acceptedOrderId` (unique)
- `amountCents` Int, `currency`, `percentOfTotal` Decimal?
- `dueDate`, `status` enum `INVOICED | PAID | WAIVED | PENDING`
- `qboInvoiceId` String? (linked when deposit invoice raised in QBO)

### ProcurementLine
- `id`, `acceptedOrderId`
- `catalogItemId`, `description`, `quantity`, `unit`
- `vendor` String?, `estimatedCostCents` Int?, `status` enum `TO_ORDER | ORDERED | RECEIVED | BACKORDERED`
- Seeded from the accepted proposal's **INCLUDED** catalog line items only.

### HandoffRequirement
- `id`, `acceptedOrderId`
- `category` enum `HandoffCategory`:
  `PRODUCTION | CUSTOM_PRODUCT | SHIPPING | INSTALLATION | TRAINING | CUSTOMER_RESPONSIBILITY | FACILITY_ACCESS`
- `title`, `details` (text), `required` Boolean, `status` enum `PENDING | IN_PROGRESS | COMPLETE | BLOCKED`
- One or more rows per category; seed defaults per category (see "Seeding" below).

### HandoffDocument
- `id`, `acceptedOrderId`
- `name`, `docType` enum `CONTRACT | PERMIT | SPEC | DRAWING | WARRANTY | SIGNOFF | OTHER`
- `required` Boolean, `status` enum `MISSING | REQUESTED | RECEIVED`, `fileRef` String?

### HandoffTask (internal work)
- `id`, `acceptedOrderId`
- `title`, `description`, `assigneeUserId` String?, `role` String? (target role if unassigned)
- `targetDate` DateTime?, `status` enum `TODO | DOING | DONE | BLOCKED`
- `isException` Boolean (exception flag), `exceptionReason` String?
- `mondayItemId` String? (linked when pushed to monday board)

### OrderEvent (append-only audit)
- `id`, `acceptedOrderId`
- `type` String (e.g. `ORDER_LOCKED`, `APPROVAL_RECORDED`, `DEPOSIT_INVOICED`, `QBO_ESTIMATE_CREATED`,
  `MONDAY_PROJECT_CREATED`, `REQUIREMENT_UPDATED`, `TASK_UPDATED`, `STATUS_CHANGED`, `INTEGRITY_VERIFIED`,
  `INTEGRITY_DRIFT_DETECTED`)
- `payload` Json, `actorUserId` String?, `createdAt`
- **Never** updated or deleted. Insert-only.

---

## Lock & integrity (`src/handoff/lock.ts`)
- `buildContentSnapshot(version, priceSnapshot)` → canonical object of the accepted content.
- `canonicalize(obj)` → deterministic JSON (sorted keys, normalized numbers) for hashing.
- `computeIntegrityHash({proposalVersionId, priceSnapshotId, contentSnapshot})` → SHA-256 hex.
- `verifyIntegrity(acceptedOrder)` → recompute hash from stored refs + snapshot; return
  `{ ok: boolean, expected, actual }`. Also re-read the current live version/snapshot and report
  whether they still match the frozen snapshot, so drift from later proposal edits is surfaced (but
  the order is NOT mutated).

---

## Service (`src/handoff/service.ts`)
`lockAcceptedOrder({ proposalVersionId, actorUserId, approval })` runs in **one Prisma transaction**:
1. Load the ProposalVersion + its PriceSnapshot; assert version is the latest accepted-eligible one.
2. Reject if an AcceptedOrder already exists for this proposal (idempotency guard).
3. Build content snapshot + integrity hash; create AcceptedOrder (`status: ACCEPTED`).
4. Create CustomerApproval from `approval`.
5. Create DepositRequirement (default: percent of total from proposal terms, or PENDING if none).
6. Seed ProcurementLine rows from INCLUDED catalog line items.
7. Seed HandoffRequirement rows for all 7 categories (defaults below).
8. Seed HandoffDocument rows (contract + category-driven docs).
9. Seed HandoffTask rows (internal kickoff tasks with target dates + role targets).
10. Append `ORDER_LOCKED` + `APPROVAL_RECORDED` OrderEvents.
All-or-nothing: if any step fails, nothing is persisted.

**Post-transaction integration side effects** (DECIDED, see below): after commit, call QBO estimate
creation (M10) and monday project create/update (M11) with bounded retry; store returned ids; emit
success/failure events; never throw out of the request; idempotent + re-runnable via retry endpoint.

### Seeding defaults per category
- PRODUCTION: build/assembly requirement per custom or made-to-order line.
- CUSTOM_PRODUCT: one requirement per custom line (specs, approval drawing).
- SHIPPING: freight method, delivery window, receiving contact.
- INSTALLATION: site survey, install crew, schedule window.
- TRAINING: end-user training session, materials.
- CUSTOMER_RESPONSIBILITY: site prep, power/network, access windows.
- FACILITY_ACCESS: dock/hours, badges, COI requirements.

---

## Routes (`src/routes/orders.ts`)
Reuse existing authz middleware. New permissions: `orders:read`, `orders:manage`, `handoff:manage`
(grant to Ops, PM, Sales-Manager, Exec, Accounting, Installer per existing role→perm map).

- `POST /orders/from-version/:versionId` — `orders:manage`. Body: approval fields. Calls
  `lockAcceptedOrder`. Returns the created order with sub-records. **Separate** from the proposal
  accept endpoint (see decision 2).
- `GET /orders/:id` — `orders:read`. Full order + sub-records.
- `GET /orders/:id/verify` — `orders:read`. Runs `verifyIntegrity`, appends
  `INTEGRITY_VERIFIED` or `INTEGRITY_DRIFT_DETECTED` event, returns the result.
- `GET /orders/:id/status` — `orders:read`. Handoff-status report: rollup of requirement/task/
  procurement/document completion %, open exceptions, deposit status, integration link status,
  overdue tasks (targetDate < now && status != DONE).
- `PATCH /orders/:id/requirements/:reqId` and `.../tasks/:taskId` — `handoff:manage`. Update
  status/assignee/dates/exception; append `REQUIREMENT_UPDATED` / `TASK_UPDATED` events.
- `POST /orders/:id/retry-integrations` — `orders:manage`. Re-attempt any QBO/monday link still null.
- `GET /orders/:id/events` — `orders:read`. Append-only audit history, newest first.

---

## Two decisions (DECIDED — implement as stated)
1. **Integration wiring — WIRE IT.** After the lock transaction commits, call the Milestone 10 QBO
   estimate creation and the Milestone 11 monday project creation as **post-transaction side
   effects**, store the returned `qboEstimateId` / `mondayProjectId` on the AcceptedOrder, and emit
   `QBO_ESTIMATE_CREATED` / `MONDAY_PROJECT_CREATED` OrderEvents. Requirements:
   - Run them AFTER commit so an external API outage never rolls back the lock.
   - Each call gets bounded retry (e.g. 3 attempts, exponential backoff). On final failure, emit a
     `QBO_ESTIMATE_FAILED` / `MONDAY_PROJECT_FAILED` event with the error and leave the id null — do
     not throw out of the request.
   - Make both idempotent: if the order already has the id set, skip. Expose a
     `POST /orders/:id/retry-integrations` (`orders:manage`) to re-attempt any that are still null.
   - When a monday project already exists for the proposal (update case), update it instead of
     creating a duplicate.
2. **Accept coupling — KEEP SEPARATE.** `POST /orders/from-version/:versionId` stays the explicit
   operational-lock endpoint (it requires approval metadata Ops supplies). The customer-facing
   proposal-accept route does NOT auto-create the order. To make the step discoverable, on successful
   proposal acceptance return a hint/link indicating the order can now be locked, but leave creation
   to the explicit endpoint.

---

## Tests to write
- `tests/unit/handoff-lock.test.ts` — snapshot determinism, hash stability, drift detection when a
  new proposal version is created after lock.
- `tests/integration/handoff-service.test.ts` — full lock transaction seeds all sub-records; rollback
  on failure; idempotency guard.
- `tests/integration/orders-authz.test.ts` — each route enforces the correct permission; forbidden
  roles get 403.
- integration side-effect coverage: lock still succeeds when QBO/monday calls fail (ids null, failure
  events emitted); `retry-integrations` fills nulls and is idempotent when ids already set.

## Acceptance criteria
- Accepting locks an immutable order pinned to exact version + price snapshot.
- Editing the proposal afterward (new version) does not change the accepted order; `verify` flags drift.
- All handoff categories, tasks (with target dates + exception flags), procurement, documents, deposit,
  and approval are recorded.
- `/status` gives an accurate handoff rollup; `/events` gives complete append-only audit history.
- `pnpm check && pnpm test` pass.

## Deploy checklist (post-implementation)
1. Run `0012_accepted_orders` migration.
2. Vercel + Postgres secrets: `DATABASE_URL`, `DIRECT_URL`, QBO + monday env vars, QBO token
   encryption key.
3. Real values: Intuit client id/secret, monday.com API key, approved product sync list.
4. Sandbox test plan: monday board + QBO sandbox company end-to-end.

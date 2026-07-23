# Accepted Order & Operational Handoff

Status: **scaffold authored.** Apply migration `0012_accepted_orders`; run
`pnpm check` and `pnpm test`. No external side effects — QuickBooks and
monday.com actions are represented as handoff tasks/links and executed via their
own gated integrations (Milestones 10–11).

## 1. The lock

When a proposal version reaches **ACCEPTED**, it is locked into an
**AcceptedOrder** via `POST /orders/from-version/:versionId` (permission
`orders:manage`), which also records the **customer approval**. The order:

- references the **exact** `proposalVersionId` + `priceSnapshotId` (both unique-anchored);
- stores a **frozen content snapshot** (sections, items, currency, grand total, deposit due);
- stores an **integrity hash** over that content.

Proposal versions are already immutable once RELEASED; the only way to change a
proposal is a **new version**, which produces a **separate** order (or none).
The order never reads the live proposal for money or scope — so later edits
**cannot silently alter the accepted order**. `GET /orders/:id/verify`
recomputes the hash from the referenced version + snapshot and reports any drift
(`ok:false`) as defense in depth.

## 2. What the order carries

| Requirement | Where |
|---|---|
| Accepted proposal lock | `AcceptedOrder` (frozen snapshot + `locked`, `integrityHash`) |
| Customer approval record | `CustomerApproval` (method, approver, PO#, signed-at, document ref) |
| Deposit requirement | `AcceptedOrder.depositRequired` + `depositDueMinor` (from frozen schedule) |
| QuickBooks action | Seeded task "Create QuickBooks deposit invoice" + `qboEstimateTxnId` link |
| monday.com project create/update | Seeded task + `mondayProjectId` link |
| Procurement list | `ProcurementLine[]` (from accepted INCLUDED items) |
| Production / custom-product / shipping / installation / training requirements | `HandoffRequirement[]` by `RequirementCategory` |
| Customer responsibilities | `HandoffRequirement(category=CUSTOMER_RESPONSIBILITY)` |
| Facility access information | `HandoffRequirement(category=FACILITY_ACCESS)` |
| Required documents | `HandoffRequirement(category=REQUIRED_DOCUMENT)` |
| Internal task assignment | `HandoffTask` (assigneeId / assigneeRole) |
| Target dates | `targetDate` (requirements/procurement), `dueDate` (tasks) |
| Exception flags | `isException` + `exceptionReason` on requirement / task / procurement |
| Complete audit history | `OrderEvent[]` (order-scoped timeline) + global `AuditLog` |
| Handoff-status reporting | `GET /orders/:id/status` |

Operational sub-records are **mutable** (that is the point of the handoff); the
**financial snapshot is not** — there is no API that edits the order total,
accepted content, or version reference.

## 3. Seeded scaffold

On lock the order is seeded with: a requirement per operational category, a
procurement line per accepted INCLUDED item, and internal tasks (deposit invoice
— only if a deposit is due, monday project, procurement, shipping, installation,
training). Owners are set by role; assign specific users via
`PATCH /orders/tasks/:id`.

## 4. Status derivation & reporting

`GET /orders/:id/status` returns rollups (tasks & requirements by status,
procurement sourced count), the deposit state, customer approval, integration
links, the open **exception** list, and the live **integrity** check. Overall
`HandoffStatus` is derived automatically: `COMPLETE` when nothing is open,
`BLOCKED` if anything is blocked, otherwise `IN_PROGRESS` / `NEW`.

## 5. Endpoints

| Method | Path | Permission |
|---|---|---|
| POST | `/orders/from-version/:versionId` | `orders:manage` |
| GET | `/orders`, `/orders/:id` | `orders:read` |
| GET | `/orders/:id/status`, `/audit`, `/verify` | `orders:read` |
| POST/PATCH | `/orders/:id/requirements`, `/orders/requirements/:id` | `handoff:manage` |
| POST/PATCH | `/orders/:id/tasks`, `/orders/tasks/:id` | `handoff:manage` |
| POST | `/orders/:id/procurement` | `handoff:manage` |
| POST | `/orders/:id/integrations` | `orders:manage` |

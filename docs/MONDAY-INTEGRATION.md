# monday.com Integration — Mapping & Source of Truth

Status: design + scaffold. Extends Milestone 4 (basic opportunity push) into the
full two-way integration. **Not executed here** — see the manual test procedure
and automated tests. Use a **sandbox/test board** before production (set
`MONDAY_DEALS_BOARD_ID` to the sandbox board id).

## 1. Entity mapping (CPQ ⇄ monday.com)

| CPQ entity | monday.com object | Link direction | Notes |
|---|---|---|---|
| Organization | Item on **Accounts** board | CPQ → monday (create/update) | CPQ authoritative |
| Contact | Subitem/Item on **Contacts** board, linked to Account | CPQ → monday | CPQ authoritative |
| Opportunity | Item on **Deals** board | **Two-way** | stage/owner two-way; amounts CPQ-authoritative |
| Proposal | Update/column on the Deal item (proposal number + status + link) | CPQ → monday | CPQ authoritative |
| Accepted order | Item on **Orders** board (created when proposal ACCEPTED) | CPQ → monday | CPQ authoritative |
| Project | Item on **Projects** board (created from accepted order) | monday → CPQ for delivery status | monday authoritative for project execution status only |

Every link is stored in the `ExternalLink` table (CPQ entity ↔ monday item id),
so a CPQ record never depends on name matching.

## 2. Field mapping & **source of truth**

"Source of truth" = the system whose value wins in a conflict. The sync engine
**never overwrites an authoritative CPQ value** unless an approved conflict rule
in `conflict.ts` explicitly allows it.

| Field | CPQ location | monday column | Source of truth | Sync |
|---|---|---|---|---|
| Status (deal stage) | Opportunity.stage | Deals: `status` | **Shared** (approved rule: monday may advance stage) | two-way |
| Status (project) | — | Projects: `status` | **monday** | monday → CPQ |
| Owner | Opportunity owner | Deals: `person` | **CPQ** | CPQ → monday |
| Dates (expected close) | Opportunity.desiredTimeline / dates | Deals: `date` | **CPQ** | CPQ → monday |
| Amount (budget/total) | Opportunity.budget / PriceSnapshot total | Deals: `numbers` | **CPQ** (financials never overwritten) | CPQ → monday |
| Installation info | Room/Opportunity install fields | Deals/Orders: text cols | **CPQ** | CPQ → monday |
| Shipping info | Address (SHIPPING), freight/liftgate | Orders: text cols | **CPQ** | CPQ → monday |
| Files (proposal PDF, floor plans) | Attachment / proposal export | monday item files column | **CPQ** | CPQ → monday (upload) |
| Contact name/email/phone | Contact | Contacts columns | **CPQ** | CPQ → monday |

Rule of thumb: **all financial and contractual values are CPQ-authoritative and
are never written back from monday.** Only deal *stage* is shared, and only via
the approved conflict rule.

## 3. Conflict handling
- Each synced record stores a `syncHash` of the last-synced field set.
- **Outbound**: push only when the local hash changed (suppresses echo loops).
- **Inbound**: an incoming change is applied only if (a) the field's source of
  truth is monday or Shared, AND (b) an approved conflict rule permits it.
  Any attempt to change a CPQ-authoritative field from monday is **rejected and
  logged** to `IntegrationSyncLog` as a `conflict` — never silently applied.

## 4. Reliability controls
- **External IDs**: `ExternalLink(entity, entityId, provider, externalId, boardId)`.
- **Duplicate prevention**: unique `(provider, entity, entityId)` and unique
  `(provider, externalId)`; create is skipped if a link already exists.
- **Idempotency**: inbound webhooks deduped by unique `eventId`; outbound
  create guarded by the existing link.
- **Rate limits**: client honors HTTP 429 + `Retry-After` and monday complexity
  errors with capped exponential backoff (`client.ts`).
- **Logging**: every attempt (ok/error/conflict/skipped) → `IntegrationSyncLog`.
- **Manual retry**: `POST /integrations/monday/retry/:logId`.
- **Sync status**: `GET /integrations/monday/status` and per-entity link state.
- **Reconciliation**: `GET /integrations/monday/reconcile` reports links whose
  local hash differs from last-synced, orphaned links, and recent failures.

## 5. Manual test procedure (sandbox board)
1. Create a monday **sandbox** board named "Deals (sandbox)"; copy its id and
   column ids into env + `mapping.ts`.
2. Set `MONDAY_API_TOKEN`, `MONDAY_SIGNING_SECRET`, `MONDAY_DEALS_BOARD_ID`
   (sandbox) in `.env`.
3. **Outbound create**: create an Opportunity in CPQ → confirm a new item
   appears on the sandbox board; confirm an `ExternalLink` row + an `ok`
   `IntegrationSyncLog` row exist.
4. **Idempotency**: update the same Opportunity with no synced-field change →
   confirm NO monday write occurs (hash unchanged).
5. **Inbound stage change**: move the item's status in monday → confirm the
   webhook fires, signature validates, and the CPQ stage updates.
6. **Conflict guard**: change the amount column in monday → confirm CPQ does
   **not** change and a `conflict` log row is written.
7. **Rate limit**: temporarily lower the sandbox token's rate → confirm the
   client backs off and eventually succeeds (watch logs).
8. **Manual retry**: force an error (bad column id), see the failed log, fix,
   then `POST /integrations/monday/retry/:logId` → confirm success.
9. **Reconciliation**: run `GET /integrations/monday/reconcile` → confirm it
   lists the forced failure and any drifted records.
10. Only after all pass on the sandbox board, point env at the production board.

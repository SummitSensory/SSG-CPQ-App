# QuickBooks Online Integration — Field Mapping, Source of Truth, Test Plan

Status: **design + scaffold.** All code is implemented behind an authorization
and environment gate. **No transaction has been created in any QuickBooks
company.** Live creation requires (1) a connected realm, (2) per-transaction
user authorization, and (3) for production, `QBO_PRODUCTION_WRITE_ENABLED=true`
*after* the production test plan below is authorized.

CPQ is the system of record for **what is owed** (proposal, pricing, totals,
customer identity). QuickBooks is the system of record for the **accounting
lifecycle** once a document exists (its id/number, payment status, balance).

---

## 1. Approved workflow (accepted proposal → QuickBooks)

```
Accepted ProposalVersion (frozen)
      │  prepare  (freeze totals + idempotency key)   → QboTransaction PENDING_AUTHORIZATION
      │  authorize (explicit, logged user sign-off)   → AUTHORIZED
      │  execute  (create in QBO, requestid = key)    → CREATED  (qboId + docNumber stored)
      ▼
QuickBooks: Estimate → Deposit Invoice → Progress Invoice → Final Invoice
```

Master data is synced on demand: **Customer** (find-or-create) and, where
approved, **Item** (product/service). Every step records to `IntegrationSyncLog`
(`provider = "quickbooks"`) and `AuditLog`.

---

## 2. Entity mapping (CPQ ⇄ QuickBooks)

| CPQ entity | QuickBooks object | Direction | Link / id store |
|---|---|---|---|
| Organization | Customer | CPQ → QBO (find-or-create) | `QboEntityLink(entity="Customer")` |
| Product / Service (approved) | Item (Service / NonInventory) | CPQ → QBO | `QboEntityLink(entity="Item")` |
| Accepted proposal (grand total) | Estimate | CPQ → QBO | `QboTransaction(type=ESTIMATE)` |
| Payment schedule — deposit | Invoice | CPQ → QBO | `QboTransaction(type=DEPOSIT_INVOICE)` |
| Payment schedule — progress | Invoice | CPQ → QBO | `QboTransaction(type=PROGRESS_INVOICE)` |
| Payment schedule — final | Invoice | CPQ → QBO | `QboTransaction(type=FINAL_INVOICE)` |

External ids are always stored — a CPQ record never depends on name matching.
Links are scoped by `environment` so sandbox ids never collide with production.

---

## 3. Field mapping & source-of-truth matrix

Encoded in `src/integrations/quickbooks/source-of-truth.ts` and enforced by
`canWriteFromQbo()` (unit-tested).

| Field | CPQ location | QuickBooks field | Source of truth | Sync |
|---|---|---|---|---|
| Customer display name | Organization.name | Customer.DisplayName | **CPQ** | CPQ → QBO |
| Billing / shipping address | Address (BILLING/SHIPPING) | Customer.BillAddr / ShipAddr | **CPQ** | CPQ → QBO |
| Customer email | Contact.email (decision-maker) | Customer.PrimaryEmailAddr | **CPQ** | CPQ → QBO |
| Item name / SKU | Product.name / sku | Item.Name / Sku | **CPQ** | CPQ → QBO |
| Item type | Product.kind | Item.Type (Service/NonInventory) | **CPQ** | CPQ → QBO |
| Estimate lines | PriceSnapshot.breakdown.lines | Estimate.Line[] | **CPQ** | CPQ → QBO |
| Estimate total | PriceSnapshot.grandTotal | Estimate total | **CPQ** (never altered) | CPQ → QBO |
| Invoice amount | breakdown.payment.{deposit,progress,final} | Invoice.Line[0].Amount | **CPQ** (never altered) | CPQ → QBO |
| Currency | PriceSnapshot.currency | CurrencyRef | **CPQ** | CPQ → QBO |
| Transaction id | QboTransaction.qboId | Estimate/Invoice.Id | **QuickBooks** | QBO → CPQ |
| Document number | QboTransaction.qboDocNumber | DocNumber | **QuickBooks** | QBO → CPQ |
| Payment status / balance | (reconciliation display) | Invoice.Balance | **QuickBooks** | QBO → CPQ (read-only) |

**Rule of thumb:** every financial and contractual value is CPQ-authoritative
and is *never* written back from QuickBooks. Only QuickBooks-assigned lifecycle
identifiers (id, doc number, balance) flow inbound, and only for display.

---

## 4. Financial-safety controls (and where they live)

| Requirement | Control | Location |
|---|---|---|
| Idempotency / duplicate prevention | Unique `idempotencyKey`; same key passed to QuickBooks as `requestid`; `QboEntityLink` unique constraints for master data | `transactions.ts`, `client.ts`, `links.ts` |
| Never create twice on retry | `execute` short-circuits `CREATED`; `retry` reuses the same key/`requestid` | `transactions.ts` |
| Explicit authorization before live create | `PENDING_AUTHORIZATION → AUTHORIZED` step, `quickbooks:transact` permission | `transactions.ts`, `routes/quickbooks.ts` |
| Database transactions | `prisma.$transaction` wraps status change + id storage + log | `transactions.ts` |
| Preserve exact accepted version | Only `ACCEPTED` versions; totals frozen in `totalsSnapshot`; re-verified at execute | `transactions.ts` |
| Record QuickBooks transaction id | `qboId`, `qboDocNumber`, `qboSyncToken` stored on `QboTransaction` | schema / `transactions.ts` |
| Log initiating user | `initiatedById`, `authorizedById`; `AuditLog` on prepare/authorize/create/retry | `transactions.ts`, `lib/audit.ts` |
| Never silently alter totals | Estimate builder asserts assembled total == accepted total; execute refuses on drift | `estimates.ts`, `transactions.ts` |
| Distinguish draft/test/sandbox/live | `QboTxnStatus` (DRAFT…CREATED); `environment` (SANDBOX/PRODUCTION) on every row | schema |
| No credentials in source | Client id/secret + token key from env; OAuth tokens AES-256-GCM encrypted at rest | `config/env.ts`, `crypto.ts`, `oauth.ts` |
| No production test until authorized | `QBO_PRODUCTION_WRITE_ENABLED` gate blocks all production writes | `config/env.ts`, `transactions.ts` |

---

## 5. Sandbox test plan (run BEFORE any production use)

Perform every step against an Intuit **sandbox company**
(`QBO_ENVIRONMENT=sandbox`). Do not proceed to production until all pass.

1. **Connect** — call `GET /integrations/quickbooks/connect`, complete Intuit
   consent, confirm the `callback` stores an encrypted `QboConnection` (verify
   the DB columns are ciphertext, not readable tokens).
2. **Customer find-or-create** — `POST …/customers/:orgId/sync`; confirm one
   Customer appears in the sandbox and a `QboEntityLink` row exists. Call it
   again → confirm the **same** id returns and no duplicate is created.
3. **Item sync (approved product)** — `POST …/items/:productId/sync` with an
   `incomeAccountRef`; confirm the Item appears and re-sync is a no-op (hash
   unchanged).
4. **Prepare estimate** — accept a proposal, `POST …/transactions/prepare`
   `{type:"ESTIMATE"}`; confirm a `PENDING_AUTHORIZATION` row with the frozen
   totals snapshot and that its total equals the accepted grand total.
5. **Authorization required** — attempt `…/execute` before authorize → expect
   refusal; confirm nothing is created in QuickBooks.
6. **Authorize + execute** — `…/authorize` then `…/execute`; confirm the
   Estimate is created, `qboId`/`docNumber` stored, and an `ok` sync-log row.
7. **Idempotent retry** — re-run `…/execute` and `…/prepare` for the same
   inputs → confirm **no** second document is created (same id returned).
8. **Deposit / progress / final invoices** — prepare+authorize+execute each;
   confirm each invoice bills exactly `deposit`/`progress`/`final` from the
   frozen schedule and the three sum to the accepted grand total.
9. **Failure recovery** — force an error (e.g. revoke the token), execute →
   confirm `FAILED` with the error; restore, `…/retry` → confirm success with
   the same idempotency key and no duplicate.
10. **Totals-drift guard** — after prepare, simulate an altered snapshot →
    execute must refuse (accepted totals never altered).
11. **Reconciliation** — `GET …/reconcile`; confirm it lists the forced failure,
    any awaiting-authorization rows, and transaction counts by status.
12. **Sign-off** — record results in the production test plan and only then set
    `QBO_PRODUCTION_WRITE_ENABLED=true` and repeat 1–2 read-only checks in a
    controlled production window.

---

## 6. Reconciliation report

`GET /integrations/quickbooks/reconcile` (permission `quickbooks:manage`) returns
a read-only report for the active environment:

- `transactionCounts` — rows by status (DRAFT/PENDING/AUTHORIZED/CREATED/FAILED).
- `failed` — transactions needing a manual retry, with the error and amount.
- `awaitingAuthorization` — prepared but not yet signed off (who initiated).
- `authorizedNotCreated` — authorized but not yet in QuickBooks (stuck/among).
- `erroredLinks` — customer/item links in ERROR/CONFLICT.
- `recentSyncFailures` — last 50 `quickbooks` sync-log failures.
- `connections` + `productionWritesEnabled` — connection health and the safety gate.

Use it to confirm CPQ and QuickBooks agree, drive manual retries, and evidence
that no unauthorized or duplicate transaction exists.

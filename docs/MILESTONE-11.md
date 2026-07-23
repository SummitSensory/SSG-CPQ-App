# Milestone 11 — QuickBooks Online Integration (financial)

## Status
Scaffold authored behind an authorization + environment gate. **No transaction
has been created in any QuickBooks company.** Apply migration `0011_quickbooks`;
run `pnpm check` and `pnpm test`. **Use an Intuit sandbox company first** — see
the full sandbox test plan in `docs/QUICKBOOKS-INTEGRATION.md`. Production writes
stay blocked until `QBO_PRODUCTION_WRITE_ENABLED=true` is set *after* the
production test plan is authorized.

## Deliverables
- **Field-mapping documentation + source-of-truth matrix + sandbox test plan + reconciliation report doc:** `docs/QUICKBOOKS-INTEGRATION.md`.
- **Duplicate-prevention tests:** `tests/unit/qbo-duplicate-prevention.test.ts`.
- **Failure-recovery tests:** `tests/integration/qbo-failure-recovery.test.ts`.
- **Supporting tests:** `qbo-mapping`, `qbo-source-of-truth`, `qbo-crypto`, `qbo-routes`.

## Files
| Concern | File |
|---|---|
| Schema (connection, links, transactions) | `prisma/schema.prisma`, migration `0011_quickbooks` |
| OAuth 2.0 + token rotation | `src/integrations/quickbooks/oauth.ts` |
| Token encryption at rest (AES-256-GCM) | `src/integrations/quickbooks/crypto.ts` |
| REST client (retry/backoff + `requestid` idempotency) | `src/integrations/quickbooks/client.ts` |
| Source-of-truth registry | `src/integrations/quickbooks/source-of-truth.ts` |
| Field mapping + money conversion | `src/integrations/quickbooks/mapping.ts` |
| External-id links (duplicate prevention) | `src/integrations/quickbooks/links.ts` |
| Find-or-create customer | `src/integrations/quickbooks/customers.ts` |
| Approved product/service sync | `src/integrations/quickbooks/items.ts` |
| Estimate / invoice body builders | `src/integrations/quickbooks/estimates.ts`, `invoices.ts` |
| Transaction safety core (prepare/authorize/execute/retry) | `src/integrations/quickbooks/transactions.ts` |
| Reconciliation report | `src/integrations/quickbooks/reconcile.ts` |
| Routes | `src/routes/quickbooks.ts` |
| Env + permissions | `src/config/env.ts`, `src/authz/permissions.ts` |

## Requirement compliance
- **Find/create customers** — `findOrCreateCustomer` (link → name lookup → create); duplicate-safe.
- **Estimates / deposit / progress / final invoices** — `QboTxnType` + `prepare/authorize/execute` per type.
- **Sync products/services where approved** — `syncItem` refuses non-`ACTIVE` products; hash-skips unchanged.
- **Store QuickBooks external ids** — `QboEntityLink.qboId`, `QboTransaction.qboId/qboDocNumber/qboSyncToken`.
- **Record sync status** — `QboTxnStatus` + `IntegrationSyncLog(provider="quickbooks")`.
- **Handle failures** — try/catch → `FAILED` + error stored + logged; never half-committed (`$transaction`).
- **Manual retry** — `POST …/transactions/:id/retry` (same idempotency key).
- **Reconciliation** — `GET …/reconcile`.
- **Idempotency / never double-create on retry** — unique `idempotencyKey` passed to QBO as `requestid`; execute short-circuits `CREATED`.
- **Explicit authorization before live create** — `PENDING_AUTHORIZATION → AUTHORIZED` + `quickbooks:transact`.
- **Database transactions** — `prisma.$transaction` around status + id storage + log.
- **Preserve exact accepted version** — only `ACCEPTED` versions; totals frozen; re-verified at execute (`totalsHash`).
- **Record transaction id / log initiating user** — `qboId` + `initiatedById`/`authorizedById` + `AuditLog`.
- **Never silently alter totals** — estimate builder asserts total == accepted; execute refuses on drift.
- **Distinguish draft/test/sandbox/live** — `QboTxnStatus` + `environment` on every row/link.
- **No credentials in source** — env-only client id/secret; OAuth tokens encrypted at rest.
- **No production test until authorized** — `QBO_PRODUCTION_WRITE_ENABLED` gate.

## Follow-ups (need real values / access)
1. Intuit developer app: client id/secret, redirect URI → set `QBO_*` env in the deployment (not source).
2. Generate `QBO_TOKEN_ENC_KEY` (`openssl rand -hex 32`) as a deployment secret.
3. QuickBooks income account ref(s) for item sync — confirm with Accounting.
4. Confirm which catalog products are **approved** for QuickBooks item sync.
5. Run the sandbox test plan; capture results; authorize the production test plan before enabling production writes.

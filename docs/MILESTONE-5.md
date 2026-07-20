# Milestone 5 — Product Catalog

## Status
Scaffold authored. **Not executed** here. Apply migration `0005_catalog`; run `pnpm check` and `pnpm test`.

## No-deploy catalog management
Categories, families, products, variants, components, bundles, accessories and
services are **database records** edited through the admin API (`products:admin`).
Authorized admins change catalog content with **no code deployment**.

## Model (`prisma/schema.prisma`, migration `0005_catalog`)
ProductCategory (self-nesting), ProductFamily, Product (kind = PRODUCT / VARIANT /
COMPONENT / BUNDLE / ACCESSORY / SERVICE), ProductRelation (variant/component/
bundle/accessory links), ProductImage, TechnicalDocument, ProductVersion
(version history), ProductStatusHistory. Fields include SKU, proposal &
internal descriptions, dimensions (in), weight (oz), capacity, active/inactive
dates, admin notes. **No price fields** — pricing is deferred and absent from UI.

## Requirements → implementation
| Requirement | Where |
|---|---|
| Import validation | `src/catalog/import.ts` (per-row, batch) + `POST /catalog/import` (dry-run default) |
| Duplicate prevention | unique SKU/slug + in-batch + DB pre-check |
| Required-field validation | `src/catalog/validation.ts` (Zod) |
| Status history | ProductStatusHistory + `changeStatus` |
| Audit records | `recordAudit` on every mutation |
| Role restrictions | `catalog:read` (broad) / `products:admin` (writes) |
| Safe deactivation | `changeStatus` → INACTIVE stamps activeTo; validated transitions |
| Delete protection | `assertDeletable` + FK `onDelete: Restrict`; ever-active or referenced products can only be archived |
| Version history | ProductVersion snapshot on create & every update |

## Tests
- Unit: `catalog-validation` (required fields, SKU/slug format, date order, non-negative weight); `catalog-import` (clean batch, in-batch dup SKU, required-field row errors); `catalog-service` (legal transitions, hard-delete policy).
- Integration: `catalog-authz` (non-admin create → 403, unauthenticated import → 401).

## Not tested / out of scope
- Pricing (deferred; intentionally absent).
- DB-backed create/update/version round-trips and the transactional import commit need a test DB (covered by design + pure-function tests).
- Historical-proposal reference check currently uses the "ever-active" policy + relation FKs; when the proposals module lands, extend `assertDeletable` with an explicit proposal-line reference count.
- Actual binary upload transfer for images/docs (metadata/keys only).

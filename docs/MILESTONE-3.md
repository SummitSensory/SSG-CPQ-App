# Milestone 3 — CRM & Opportunity

## Status
Scaffold authored on top of Milestones 1–2. **Not executed** here (no terminal/DB).
Apply migration `0003_crm` with `pnpm db:migrate`; run `pnpm check` and `pnpm test`.

## Data model (`prisma/schema.prisma`, migration `0003_crm`)
Organization, Contact, Address (BILLING/SHIPPING), Facility, Room (site-survey
dimensions & logistics), Opportunity, OpportunityStakeholder (decision-makers),
Attachment (photograph / floor plan / measurement document / other).

Captured fields include: customer type, opportunity stage, therapy disciplines,
patient populations, budget (integer minor units + currency), desired timeline,
funding status, tax-exempt status/id, room length/width/ceiling height, floor
type, wall construction, door dimensions, loading dock, liftgate requirement,
delivery & installation restrictions, notes.

## Capabilities → file
| Capability | File |
|---|---|
| Validation | `src/crm/validation.ts` (Zod) |
| Duplicate detection | `src/crm/duplicates.ts` (org normalized-name, contact email) |
| Search / filter / sort / paginate | `src/crm/query.ts`, `src/routes/crm.ts` |
| Audit history | `src/lib/audit.ts` + AuditLog (entity/entityId) |
| Role permissions | `src/authz/permissions.ts` (crm:read / crm:write) |
| File uploads / photos / floor plans / measurement docs | Attachment model + `POST /crm/attachments` (presigned-key pattern) |
| Mobile-responsive screen | `CRM Opportunity.dc.html` |

## Requirement compliance
- Money never uses floats — budget stored as `BigInt` minor units; validation rejects non-decimal strings.
- No schema change without a migration — `0003_crm`.
- Authorization enforced server-side (`requirePermission`) on every CRM route, not by hiding UI.
- Duplicate detection returns 409 with candidates unless `?force=true`.
- Sort fields are whitelisted — arbitrary column injection is impossible.

## Tests
- Unit: `crm-validation`, `crm-duplicates`, `crm-query`.
- Integration: `crm-authz` (401 unauthenticated, 403 for READ_ONLY/INSTALLER writes, unknown role rejected) — runs DB-free because authz precedes DB access.
- E2E: `e2e/crm.spec.ts` — full org→opportunity→list flow; **skipped unless E2E_TOKEN + live stack** are provided.

## Not tested / out of scope
- Product pricing (deferred).
- DB-backed happy-path CRUD (create/read round-trips) needs a provisioned test DB — covered by design and the skipped e2e spec.
- Actual binary upload transfer to object storage (only metadata/keys are modeled).
- The mobile screen is a static representative UI, not wired to the live API.

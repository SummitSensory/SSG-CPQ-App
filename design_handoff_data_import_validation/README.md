# Handoff: Data Import & Historical Validation Milestone

## Purpose of this package
This is an **implementation spec for Claude Code**, not a UI design bundle. It defines the data-import
and historical-validation process for the existing proposal/CRM codebase (Milestones 1–13: auth/roles,
catalog, proposals with versions + price snapshots, QBO integration, monday.com integration,
accepted-order/handoff lock, reporting/metric dictionary). Hand this folder to Claude Code and
implement against the repo's stack (Prisma + Postgres, TypeScript, existing pricing engine, existing
QBO/monday clients).

If any assumption conflicts with the real repo, prefer the repo's conventions and note the deviation.

---

## Goal
Import (or validate-only) legacy data into the new system safely and idempotently, preserving source
identifiers and external IDs, with per-row validation, error reporting, duplicate prevention, batch +
source-file tracking, rollback where practical, and a strict rule that **historical proposal totals
are never altered**. Separately, use anonymized historical proposals to **validate the pricing
engine** and produce a reconciliation report.

Two distinct pipelines share one framework:
1. **Import pipeline** — writes new records for reference/master data and historical documents.
2. **Validation/reconciliation pipeline** — replays historical proposals through the current pricing
   engine WITHOUT mutating them, comparing stored vs recomputed totals.

---

## Core principles
1. **Everything is a batch.** No ad-hoc writes. Every import runs under an `ImportBatch` with a stored
   reference to the `ImportSource` (the uploaded file + checksum).
2. **Validate before write.** Two-phase: (a) parse + validate ALL rows, (b) commit only if the batch
   passes policy (configurable: fail-batch-on-any-error vs commit-valid-skip-invalid). Invalid rows are
   ALWAYS recorded in the error report — **never silently discarded**.
3. **Idempotent.** Re-running the same source file (same checksum) does not create duplicates.
   Dedupe on a natural/source key per entity (see keys below). Safe reprocessing is a first-class flow.
4. **Preserve identity.** Store the original source id and any external `mondayId` / `qbId` on the
   target record — never regenerate or drop them.
5. **Reversible where practical.** Reference-data imports are rollback-able by batch. Imports that
   trigger external side effects (QBO/monday writes) are import-only-as-links (we store external IDs,
   we do NOT create external records during import) so there is nothing external to undo.
6. **Historical immutability.** Imported historical proposals keep their stored totals verbatim. The
   pricing engine is never run to overwrite them; reconciliation is read-only comparison.

---

## Data model (Prisma) — new migration `0014_data_import`
### ImportSource
- `id`, `filename`, `contentHash` (SHA-256 of file bytes, unique-per-entity guard),
  `sizeBytes`, `mimeType`, `uploadedByUserId`, `uploadedAt`, `storageRef` (where the raw file lives).

### ImportBatch
- `id`, `importSourceId`, `entityType` enum
  (`ORGANIZATION | CONTACT | PRODUCT | PRODUCT_VARIANT | PRICE_LIST | PRODUCT_COST | OPPORTUNITY |
  PROPOSAL | ACCEPTED_PROPOSAL`),
- `mode` enum `IMPORT | VALIDATE_ONLY`,
- `policy` enum `FAIL_ON_ANY_ERROR | COMMIT_VALID_SKIP_INVALID`,
- `status` enum `PENDING | VALIDATING | VALIDATED | COMMITTING | COMMITTED | FAILED | ROLLED_BACK`,
- counts: `totalRows, validRows, invalidRows, insertedRows, updatedRows, skippedDuplicateRows`,
- `startedAt, finishedAt, createdByUserId`.

### ImportRow
- `id`, `importBatchId`, `rowNumber`, `sourceKey` (natural key from the file),
- `rawData` Json (verbatim source row — audit + reprocessing),
- `normalizedData` Json?,
- `status` enum `VALID | INVALID | INSERTED | UPDATED | SKIPPED_DUPLICATE`,
- `targetRecordType` String?, `targetRecordId` String? (link to created/matched record),
- `errors` Json (array of `{field, code, message}`).

### ImportError (denormalized for the error report; or derive from ImportRow.errors)
- Prefer a `GET` that projects `ImportRow` rows with `status = INVALID`; keep errors on the row so
  reprocessing a fixed file is straightforward.

### ReconciliationRun / ReconciliationLine (validation pipeline)
- `ReconciliationRun`: `id`, `importBatchId?`, `sourceLabel`, `createdAt`, `createdByUserId`,
  `status` enum `DRAFT | UNDER_REVIEW | APPROVED | REJECTED`, count rollups.
- `ReconciliationLine`: `id`, `reconciliationRunId`, `proposalRef` (source/imported proposal id),
  `historicalTotalCents`, `recalculatedTotalCents`, `differenceCents`,
  `differenceReason` enum
  (`MATCH | ROUNDING | PRICE_LIST_CHANGE | COST_CHANGE | DISCOUNT_RULE_CHANGE | MISSING_ITEM |
  TAX_RULE_CHANGE | DATA_ENTRY | UNKNOWN`),
  `reasonNotes` String?, `approvalStatus` enum `PENDING | APPROVED | REJECTED | WAIVED`,
  `reviewedByUserId?`, `reviewedAt?`.

---

## Per-entity import rules
For each entity define: source key (dedupe), required fields, validators, external-ID handling.

- **Organizations** — key: `sourceOrgId` or normalized name+domain. Validate name present, unique key.
  Store `qbId?`, `mondayId?` if present.
- **Contacts** — key: `sourceContactId` or email. Validate email format; must link to an org (by
  source org key). Store external IDs.
- **Products** — key: SKU. Validate SKU unique, name present, category resolvable.
- **Product variants** — key: variant SKU / (productSKU+variantCode). Must resolve to a product.
- **Price lists** — key: (priceListCode + productSKU/variantSKU + effectiveDate). Validate currency,
  non-negative price, product resolvable, no overlapping effective ranges for same key.
- **Product costs** — key: (productSKU/variantSKU + effectiveDate). Non-negative cost; resolvable
  product. `reports:financials`-class data — restrict who can import.
- **Existing opportunities** — key: `sourceOppId`. Validate stage in allowed set; owner resolvable
  (map source rep → user, unresolved = error, not silent drop).
- **Historical proposals** — key: `sourceProposalId`. Import as a version with a **frozen price
  snapshot built from the file's stored line items and totals** — DO NOT recompute. Validate totals
  arithmetic is internally consistent (sum of lines == stored subtotal ± stored discount/tax ==
  stored total); if inconsistent, flag as INVALID but preserve the stored total verbatim (never
  overwrite). Store `qbId?`, `mondayId?`.
- **Accepted proposals** — key: `sourceProposalId` (+ acceptance marker). Import the historical
  accepted state referencing the imported version + its frozen snapshot (reuse Milestone 12
  AcceptedOrder model, `contentSnapshot` = stored historical content, integrity hash over it). Do NOT
  run new pricing.
- **External monday IDs / QuickBooks IDs** — imported as attributes on the above records (never as
  triggers to create external records). A validate step may optionally check the ID exists in the
  external system (read-only) and flag mismatches, but import itself only stores the link.

External-ID rule: if a row carries a `mondayId`/`qbId`, persist it exactly; if it collides with a
different record, that is an INVALID row (reported), not an overwrite.

---

## Import engine (`src/import/`)
- `parse/<entity>.ts` — file → raw rows (support CSV; keep the parser pluggable for XLSX/JSON).
- `validate/<entity>.ts` — pure per-row validators returning `errors[]`. Cross-row checks
  (uniqueness, overlaps, referential resolution) run after per-row parse.
- `commit/<entity>.ts` — upsert by source key inside a transaction; sets ImportRow status
  (INSERTED/UPDATED/SKIPPED_DUPLICATE) and `targetRecordId`.
- `runBatch(sourceId, entityType, mode, policy)` orchestrates: dedupe-check the source `contentHash`
  (already-committed source with same hash + entity ⇒ refuse or route to reprocess), validate all,
  then commit per policy. Emit an `ImportBatch` with full counts.
- **Reprocessing**: re-uploading a corrected file creates a new batch; rows matching existing
  target records by source key UPDATE rather than duplicate. Provide `reprocess(batchId)` that reruns
  from stored `rawData` after validator fixes.

## Rollback
- `rollbackBatch(batchId)` — for reference-data entities, delete/restore records inserted/updated by
  that batch (use ImportRow.targetRecordId + a pre-image where UPDATE occurred; store pre-image in
  ImportRow for updated rows). Mark batch `ROLLED_BACK`. Historical proposals/accepted proposals:
  rollback allowed only if no downstream references exist; otherwise return a blocked result listing
  the blockers (never partial-delete silently).

## Error report
- `GET /import/batches/:id/errors` — every INVALID row with `rowNumber`, `sourceKey`, per-field
  `{field, code, message}`, and the raw values. Also downloadable as CSV. The report is produced for
  EVERY batch, even fully-successful ones (empty list), so "no errors" is explicit, not assumed.

---

## Pricing-engine validation & reconciliation
Goal: confirm the current pricing engine reproduces historical totals, using **anonymized** historical
proposals.

1. **Anonymize**: `src/import/anonymize.ts` strips/obfuscates PII (org/contact names, addresses,
   emails, contact ids) while preserving pricing-relevant structure (products, variants, quantities,
   price-list refs, discounts, effective dates). Deterministic pseudonyms so lines still join.
2. **Replay**: for each historical proposal, run the CURRENT pricing engine against the
   as-of-date price list + cost to compute a fresh total. Do this in a sandbox — **never write back
   to the historical proposal**.
3. **Compare** → one `ReconciliationLine` per proposal: `historicalTotalCents`,
   `recalculatedTotalCents`, `differenceCents`, auto-classified `differenceReason` (exact match →
   MATCH; |diff| ≤ rounding tolerance → ROUNDING; else diagnose by diffing inputs: price-list vs
   cost vs discount-rule vs missing-item vs tax), and `approvalStatus` (default PENDING; MATCH auto
   APPROVED under policy).
4. **Review workflow**: reviewers (permission `import:reconcile`) set approvalStatus per line with
   notes; run rolls up to APPROVED when all non-match lines are resolved.

### Reconciliation report (required output)
`GET /reconciliation/:runId/report` (and CSV export) with columns:
**Proposal | Historical total | Newly calculated total | Difference | Reason for difference |
Approval status** — plus run-level summary (count matched, count within tolerance, count differing,
$ variance, % approved). This is the deliverable that proves pricing-engine correctness.

---

## API (`src/routes/import.ts`, `src/routes/reconciliation.ts`)
Permissions: `import:manage` (upload/commit/rollback), `import:read` (view batches/errors),
`import:reconcile` (review reconciliation). Cost/price imports additionally require the financial
permission from the reporting milestone (`reports:financials`-equivalent).

- `POST /import/sources` — upload file → ImportSource (stores hash + raw).
- `POST /import/batches` — `{importSourceId, entityType, mode, policy}` → runs validate (+commit if
  mode=IMPORT and policy passes). Returns batch with counts.
- `GET /import/batches` / `GET /import/batches/:id` — status + counts.
- `GET /import/batches/:id/errors` — error report (JSON + `?format=csv`).
- `POST /import/batches/:id/reprocess` — rerun from stored rows.
- `POST /import/batches/:id/rollback` — rollback where practical; returns blockers if not.
- `POST /reconciliation/runs` — `{sourceLabel, batchId?, tolerance}` → replays + builds lines.
- `GET /reconciliation/runs/:id` and `/report` (+`?format=csv`).
- `PATCH /reconciliation/runs/:id/lines/:lineId` — set approvalStatus + notes (`import:reconcile`).

---

## Tests
- `tests/unit/import-validation.test.ts` — each entity validator: required fields, formats,
  referential resolution, external-ID collision → INVALID (not overwrite).
- `tests/unit/import-dedupe.test.ts` — same source hash refused/reprocessed; source-key upsert
  updates instead of duplicating; re-run is idempotent.
- `tests/unit/import-historical-immutability.test.ts` — importing a historical proposal never changes
  its stored total; inconsistent totals flagged INVALID yet preserved verbatim.
- `tests/integration/import-batch-rollback.test.ts` — commit then rollback restores prior state;
  rollback blocked when downstream refs exist (no partial delete).
- `tests/integration/import-error-report.test.ts` — invalid rows always appear in the report; nothing
  silently discarded; empty report on clean batch.
- `tests/unit/pricing-reconciliation.test.ts` — anonymization preserves pricing structure; replay
  reproduces MATCH on unchanged inputs; classifier assigns correct reason for injected price/cost/
  discount changes; rounding tolerance respected.
- `tests/integration/reconciliation-report.test.ts` — report columns + rollups reconcile to lines;
  approval workflow transitions.

## Acceptance criteria
- Every listed entity imports or validates with per-row validation and a persistent error report.
- No duplicate imports; safe reprocessing; source ids + external monday/QBO ids preserved.
- Batches + source files recorded; rollback works where practical (blockers reported otherwise).
- Invalid data never silently discarded; historical proposal totals never altered on import.
- Anonymized historical proposals drive pricing-engine validation.
- Reconciliation report shows historical total, newly calculated total, difference, reason, approval
  status, with run-level rollups and CSV export.
- `pnpm check && pnpm test` pass.

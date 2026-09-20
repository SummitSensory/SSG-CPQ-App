-- 0094_esign_envelope_live_unique
--
-- Enforces "only one envelope is live per proposal version" (EsignEnvelope's own
-- header comment in src/integrations/docuseal/service.ts) at the database level.
-- Previously this was only an application-level read-then-write check
-- (sendProposalForSignature: a findFirst for an open envelope, followed much later —
-- after PDF assembly and rendering — by a create), with no lock and no constraint
-- between them. Two concurrent sends for the same version could both pass the check
-- and both create a live envelope, which is exactly the "two open signing links for
-- the same job" failure the check exists to prevent.
--
-- A plain unique index on versionId would be wrong: a version legitimately
-- accumulates several envelopes over time (voided, declined, completed, then a new
-- one sent). Only one may be LIVE (DRAFT/SENT/VIEWED/PARTIALLY_SIGNED — the `LIVE`
-- array in service.ts) at once, hence a partial index scoped to those statuses.
--
-- Prisma's schema DSL cannot express a partial/filtered unique index, so this index
-- has no corresponding line in schema.prisma and will never appear as drift —
-- verified against this database before writing this migration (`pnpm db:drift`
-- reports the same pre-existing, unrelated drift with or without this index
-- present). The application-side change (service.ts catching the resulting unique
-- violation and translating it into the existing "already has a signature request
-- out" ValidationError) ships in the same commit as this migration.
--
-- NOTE: `pnpm db:new --guard` also regenerated the same pre-existing DROP
-- COLUMN/DROP TYPE statements for CrossBorderSetting/ProposalCustomsEntry
-- GST-HST/tariff fields and GstHstTreatment that migration 0092 already
-- documented and deliberately excluded: the connected database carries schema
-- from the not-yet-merged claude/canadian-proposal-v1-1 branch, which main's
-- prisma/schema.prisma does not have yet. Excluded here for the same reason —
-- applying them would destroy another in-flight feature's columns.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

CREATE UNIQUE INDEX IF NOT EXISTS "EsignEnvelope_versionId_live_unique"
  ON "EsignEnvelope" ("versionId")
  WHERE status IN ('DRAFT', 'SENT', 'VIEWED', 'PARTIALLY_SIGNED');

-- 0101_mats_freight_tax_sync
--
-- Let a freight sync carry the Mat Freight Tax Pass-Through onto a released
-- proposal. The deal board holds it in formula_mkzde17n; it is staged as a
-- FreightEntry of the new kind MATS_TAX, applied to the proposal's Tax field with
-- the freight, and billed to the QuickBooks R-TAX item. priorAmountMinor records
-- the tax the proposal carried before, so the invoice is billed only the
-- difference and never the same tax twice. Additive only: nothing existing changes.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterEnum
ALTER TYPE "FreightBucketKind" ADD VALUE IF NOT EXISTS 'MATS_TAX';

-- AlterTable
ALTER TABLE "FreightEntry" ADD COLUMN IF NOT EXISTS "priorAmountMinor" INTEGER;

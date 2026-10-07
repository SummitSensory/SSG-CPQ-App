-- 0111_bom_sequence_heading
--
-- Lets the manufacturing team decide how a Bill of Materials reads instead of it
-- following the proposal: a preset position and heading per part in the catalog
-- (Sku.bomSortOrder / Sku.bomGroup), a standing vendor note per part (Sku.bomNote),
-- and a per-order override of position and heading on each line
-- (ProcurementLine.bomPosition / ProcurementLine.bomGroup). All nullable; NULL keeps
-- today's behaviour, so no existing order or sheet changes until someone sets one.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "bomGroup" TEXT;
ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "bomPosition" INTEGER;

ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "bomGroup" TEXT;
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "bomNote" TEXT;
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "bomSortOrder" INTEGER;

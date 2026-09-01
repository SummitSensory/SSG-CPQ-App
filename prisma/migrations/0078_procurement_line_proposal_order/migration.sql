-- 0078_procurement_line_proposal_order
--
-- Adds the column that lets a Bill of Materials print in the same order as the
-- proposal it came from, instead of by product tree or SKU. NULL on rows locked
-- before this column existed, or added to the order by hand afterward.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS     "proposalLineOrder" INTEGER;

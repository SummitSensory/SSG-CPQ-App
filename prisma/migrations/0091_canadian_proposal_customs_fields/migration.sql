-- 0091_canadian_proposal_customs_fields
--
-- Adds the manually-typed tariff/customs classification code to a proposal's customs
-- entry, and three admin-configurable Section B offering toggles (on-site assembly,
-- clinical training, annual inspection/service agreement) to CrossBorderSetting, all
-- default-off — infrastructure for the Canadian-proposal document redesign. Nothing
-- about an existing proposal changes: every new column is nullable or defaults to its
-- current effective behaviour.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting"
  ADD COLUMN IF NOT EXISTS "offerAnnualInspectionAgreement" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "offerClinicalTraining" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "offerOnSiteAssembly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN IF NOT EXISTS "tariffClassificationCode" TEXT;

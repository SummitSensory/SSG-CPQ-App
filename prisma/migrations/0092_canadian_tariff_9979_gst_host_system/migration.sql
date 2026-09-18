-- 0092_canadian_tariff_9979_gst_host_system
--
-- Adds three manually-entered customs fields to ProposalCustomsEntry (tariff item
-- 9979.00.00 disability-relief claim status, GST/HST treatment status, and the host
-- system model for replacement/expansion parts) and two matching admin-configurable
-- default postures to CrossBorderSetting, for the Canadian tariff 9979.00.00 /
-- GST-HST-relief round of the Canadian-proposal document redesign. Every new column
-- is nullable with no @default, so nothing about an existing proposal or setting
-- changes: a new customs entry is seeded from the admin defaults exactly like
-- importerOfRecord already is, and an existing row is untouched.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GstHstTreatment') THEN
  CREATE TYPE "GstHstTreatment" AS ENUM ('STANDARD_RATE', 'MEDICAL_DEVICE_RELIEF_CLAIMED');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "CrossBorderSetting"
  ADD COLUMN IF NOT EXISTS "defaultGstHstTreatment" "GstHstTreatment",
  ADD COLUMN IF NOT EXISTS "defaultTariff9979Claimed" BOOLEAN;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry"
  ADD COLUMN IF NOT EXISTS "gstHstTreatment" "GstHstTreatment",
  ADD COLUMN IF NOT EXISTS "hostSystemModel" TEXT,
  ADD COLUMN IF NOT EXISTS "tariff9979Claimed" BOOLEAN;

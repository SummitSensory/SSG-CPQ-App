-- 0106_canadian_tariff_9979_wording
--
-- Makes the wording printed in the Section C tariff item 9979.00.00 row editable
-- instead of fixed in code: three admin-edited strings on CrossBorderSetting (what
-- prints when the claim is claimed / not claimed / not yet determined) and one
-- hand-typed per-proposal override on ProposalCustomsEntry. Every column is nullable
-- with no default, and null prints the same wording as before ("Claimed", "Not
-- claimed", "Not yet determined"), so no existing proposal's document changes.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "tariff9979ClaimedText" TEXT;
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "tariff9979NotClaimedText" TEXT;
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "tariff9979UndeterminedText" TEXT;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN IF NOT EXISTS "tariff9979TextOverride" TEXT;

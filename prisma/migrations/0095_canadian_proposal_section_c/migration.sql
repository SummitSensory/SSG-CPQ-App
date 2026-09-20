-- 0095_canadian_proposal_section_c
--
-- Adds the remaining Canadian Section C ("Canadian Import Terms") fields: a customs
-- broker identity (name + address), country of origin, an admin-managed ordered
-- Section C row template plus a per-proposal override list (so Bryan can add/remove/
-- reorder rows without a code change), and org-default + per-proposal-override text
-- for the Acceptance-page addendum and the tariff/duty-audit clause. Every new column
-- is nullable with no @default, so nothing about an existing proposal or setting
-- changes; a new customs entry is seeded from the admin defaults exactly like
-- importerOfRecord/gstHstTreatment/tariff9979Claimed already are.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting"
  ADD COLUMN IF NOT EXISTS "defaultAcceptanceText" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultAuditLanguageText" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultCountryOfOrigin" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultCustomsBrokerAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultCustomsBrokerName" TEXT,
  ADD COLUMN IF NOT EXISTS "sectionCTemplate" JSONB;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry"
  ADD COLUMN IF NOT EXISTS "acceptanceTextOverride" TEXT,
  ADD COLUMN IF NOT EXISTS "auditLanguageOverride" TEXT,
  ADD COLUMN IF NOT EXISTS "countryOfOrigin" TEXT,
  ADD COLUMN IF NOT EXISTS "customsBrokerAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "customsBrokerName" TEXT,
  ADD COLUMN IF NOT EXISTS "sectionCItems" JSONB;

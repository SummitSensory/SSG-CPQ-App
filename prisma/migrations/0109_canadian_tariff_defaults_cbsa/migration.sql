-- 0109_canadian_tariff_defaults_cbsa
--
-- Adds a fourth answer to a Canadian proposal's tariff item 9979.00.00 question —
-- "Claimed, subject to CBSA eligibility" — and an admin default for the tariff /
-- customs classification code, then makes both the defaults for new proposals:
--
--   * ProposalCustomsEntry.tariff9979SubjectToCbsa qualifies a claim
--     (tariff9979Claimed = true). Defaults false, so every existing entry keeps the
--     answer it has today.
--   * CrossBorderSetting.defaultTariff9979SubjectToCbsa / defaultTariffClassificationCode
--     seed a brand-new customs entry, the same seed-only way as the other defaults.
--   * CrossBorderSetting.tariff9979ClaimedSubjectToCbsaText is the editable wording
--     for the new answer; null prints "Claimed, subject to CBSA eligibility".
--
-- The seed sets the singleton's defaults to "Claimed, subject to CBSA eligibility"
-- and code 9506.91.00.90. Defaults only seed customs entries created from now on —
-- no existing proposal's answers change. It is keyed on the code still being unset,
-- so a re-run never overwrites a default an administrator has since changed.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "defaultTariff9979SubjectToCbsa" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "defaultTariffClassificationCode" TEXT;
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "tariff9979ClaimedSubjectToCbsaText" TEXT;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN IF NOT EXISTS "tariff9979SubjectToCbsa" BOOLEAN NOT NULL DEFAULT false;

-- Seed the defaults. Upsert so a database without the settings row yet gets one
-- (every other column takes its column default, so the feature stays as it was).
INSERT INTO "CrossBorderSetting" (
  "id",
  "defaultTariff9979Claimed",
  "defaultTariff9979SubjectToCbsa",
  "defaultTariffClassificationCode",
  "updatedAt"
)
VALUES ('singleton', true, true, '9506.91.00.90', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET
  "defaultTariff9979Claimed" = EXCLUDED."defaultTariff9979Claimed",
  "defaultTariff9979SubjectToCbsa" = EXCLUDED."defaultTariff9979SubjectToCbsa",
  "defaultTariffClassificationCode" = EXCLUDED."defaultTariffClassificationCode"
WHERE "CrossBorderSetting"."defaultTariffClassificationCode" IS NULL;

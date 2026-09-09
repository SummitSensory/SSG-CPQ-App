-- 0088_esign_decline_notification
--
-- Adds the guard column EsignEnvelope needs for a new staff-facing alert: an
-- instant email the first time a proposal is declined, mirroring the existing
-- countersignNotifiedAt/completionNotifiedAt/viewNotifiedAt pattern.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "declineNotifiedAt" TIMESTAMP(3);

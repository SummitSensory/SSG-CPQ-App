-- 0086_esign_view_reminder_tracking
--
-- Adds the bookkeeping EsignEnvelope needs for two new staff-facing behaviors:
-- an instant alert the first time a customer views a sent proposal, and a daily
-- reminder that repeats until the proposal is signed/declined/voided. Also
-- records the reason storeSignedCopy's last attempt did not produce a signedUrl,
-- so a stuck "Preparing the certified copy…" state is diagnosable instead of
-- silent.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "viewNotifiedAt" TIMESTAMP(3);
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "lastReminderSentAt" TIMESTAMP(3);
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "signedCopyError" TEXT;

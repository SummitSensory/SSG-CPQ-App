-- 0082_esign_notification_flags
--
-- Two nullable timestamps on EsignEnvelope that guard the countersign-needed and
-- fully-signed staff alerts (and the monday.com signed-file push) from firing
-- twice — applyStatus runs from both the DocuSeal webhook and the manual sync
-- button, and either can observe the same status transition.

-- AlterTable
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "completionNotifiedAt" TIMESTAMP(3);
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "countersignNotifiedAt" TIMESTAMP(3);

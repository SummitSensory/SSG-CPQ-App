-- Delivery confirmation for freight requests.
--
-- Bill of Materials sends already carry DELIVERED and BOUNCED, filled in by Resend's
-- webhook. Freight requests recorded only that the provider took the message, so a
-- request that bounced looked exactly like one sitting in a vendor's inbox — and a
-- freight quote nobody is working on is invisible until the job needs the number.
ALTER TYPE "FreightRfqSendStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "FreightRfqSendStatus" ADD VALUE IF NOT EXISTS 'BOUNCED';

ALTER TABLE "FreightRfqSend" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "FreightRfqSend" ADD COLUMN "openedAt" TIMESTAMP(3);

-- The webhook arrives knowing only the provider's message id.
CREATE INDEX IF NOT EXISTS "FreightRfqSend_providerMessageId_idx"
  ON "FreightRfqSend" ("providerMessageId");

-- Rollback (the enum values cannot be removed in Postgres without recreating the type)
-- DROP INDEX "FreightRfqSend_providerMessageId_idx";
-- ALTER TABLE "FreightRfqSend" DROP COLUMN "deliveredAt", DROP COLUMN "openedAt";

-- 0107_po_send_recipient_delivered
--
-- Each emailing of a purchase order now records the name of the person at the
-- vendor it was addressed to, and when the vendor's mail server confirmed delivery,
-- so the vendor's section of the order can show a complete send record.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "PurchaseOrderSend" ADD COLUMN IF NOT EXISTS "toName" TEXT;
ALTER TABLE "PurchaseOrderSend" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);

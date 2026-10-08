-- 0114_purchase_order_line_procurement_line
--
-- Generated from the difference between prisma/schema.prisma and the database.
-- A purchase order line now remembers which Bill of Materials line it was drafted
-- from, so "already on a PO" is tracked per line rather than per part number (the
-- same part in another section or another colour no longer reads as ordered).
-- Nullable and additive: existing PO lines keep NULL and fall back to the old
-- part-number match. No foreign key on purpose — a sent PO must outlive its BOM line.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN IF NOT EXISTS     "procurementLineId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_procurementLineId_idx" ON "PurchaseOrderLine"("procurementLineId");

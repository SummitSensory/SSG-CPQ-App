-- 0112_purchase_order_line_color
--
-- Generated from the difference between prisma/schema.prisma and the database.
-- Purchase order lines now carry the part's colour, copied from the Bill of Materials
-- when the PO is drafted, so a vendor ordering a painted or vinyl part sees the colour.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN IF NOT EXISTS     "powderColor" TEXT;

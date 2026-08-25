-- Vendor invoice reconciliation.
--
-- A submitted Bill of Materials is the claim: these parts, these quantities, this
-- cost. The vendor's invoice is what they say they are owed, and the two disagree
-- often enough that it was being checked in a spreadsheet nobody kept. These columns
-- put the invoice beside the sheet it belongs to.
--
-- Per LINE, the vendor's unit price as invoiced. The agreed `unitCostMinor` is left
-- alone — it is what the sheet said and what the vendor was sent — so a variance
-- stays visible instead of being overwritten by the thing it should be compared to.
ALTER TABLE "ProcurementLine" ADD COLUMN "invoicedUnitCostMinor" INTEGER;
ALTER TABLE "ProcurementLine" ADD COLUMN "invoicedAt" TIMESTAMP(3);
ALTER TABLE "ProcurementLine" ADD COLUMN "invoicedById" TEXT;

-- Per SECTION, the invoice itself: its number, its date, the total the vendor states,
-- and the acceptance of whatever difference was found.
ALTER TABLE "BomVendorSection" ADD COLUMN "vendorInvoiceNumber" TEXT;
ALTER TABLE "BomVendorSection" ADD COLUMN "vendorInvoiceDate" TIMESTAMP(3);
ALTER TABLE "BomVendorSection" ADD COLUMN "vendorInvoiceTotalMinor" INTEGER;
ALTER TABLE "BomVendorSection" ADD COLUMN "vendorInvoiceNotes" TEXT;
ALTER TABLE "BomVendorSection" ADD COLUMN "invoiceApprovedAt" TIMESTAMP(3);
ALTER TABLE "BomVendorSection" ADD COLUMN "invoiceApprovedById" TEXT;

CREATE INDEX "ProcurementLine_invoicedAt_idx" ON "ProcurementLine" ("invoicedAt");

-- Rollback
-- ALTER TABLE "ProcurementLine" DROP COLUMN "invoicedUnitCostMinor", DROP COLUMN "invoicedAt", DROP COLUMN "invoicedById";
-- ALTER TABLE "BomVendorSection" DROP COLUMN "vendorInvoiceNumber", DROP COLUMN "vendorInvoiceDate", DROP COLUMN "vendorInvoiceTotalMinor", DROP COLUMN "vendorInvoiceNotes", DROP COLUMN "invoiceApprovedAt", DROP COLUMN "invoiceApprovedById";

-- A line the vendor did not bill for.
--
-- Until now an unbilled line and an unchecked line were the same state (a NULL invoiced
-- figure), so a part they simply never charged for was invisible — and an unbilled line
-- is usually an unshipped line, which surfaces in the shop weeks later as a missing part.
ALTER TABLE "ProcurementLine" ADD COLUMN "invoiceNotBilled" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ProcurementLine_invoiceNotBilled_idx" ON "ProcurementLine" ("invoiceNotBilled") WHERE "invoiceNotBilled";

-- Rollback
-- DROP INDEX "ProcurementLine_invoiceNotBilled_idx";
-- ALTER TABLE "ProcurementLine" DROP COLUMN "invoiceNotBilled";

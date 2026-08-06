-- Vendor short code on freight RFQ references: "RFQ-12414494509-SE".
--
-- Both columns are nullable and there is no backfill. A blank vendor code falls
-- back to initials derived from the vendor name at RFQ creation, so this works on
-- day one without anyone editing the manufacturer records; and RFQs raised before
-- this migration keep the reference the vendor is already holding.

ALTER TABLE "Manufacturer" ADD COLUMN "rfqAbbrev" TEXT;
ALTER TABLE "FreightRfq" ADD COLUMN "vendorAbbrev" TEXT;

-- Submission counter. Every existing RFQ has been emailed at most once, so 1 is
-- correct for all of them and the references they carry stay as they are.
ALTER TABLE "FreightRfq" ADD COLUMN "submission" INTEGER NOT NULL DEFAULT 1;

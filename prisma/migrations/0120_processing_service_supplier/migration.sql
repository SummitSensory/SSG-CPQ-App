-- 0120_processing_service_supplier
--
-- BOM setup's "Ships through" and "Also on vendor" become one setting: a part bought
-- from its Procurement Supplier (Amazon) and sent to a Processing Service Supplier
-- (Goldberg Brothers) for repackaging. Such a part must print on BOTH vendors' Bills
-- of Materials. "Ships through" (free issue) MOVED the line instead, so the part fell
-- off the sheet of the vendor it is bought from (Bryan, 2026-10-19).
--
--   * Sku.processingEnabled  - the checkbox beside the part number.
--   * Sku.processingFeeBasis - the Repackaging Service Fee is per unit or per order.
--   * Sku.processingSku      - the processing supplier's Repackaging SKU.
--   * ProcurementLine.costPerOrder - the line's cost is charged once, not x quantity.
--   * ProcurementLine.vendorPartNo - the part number printed for its vendor,
--     snapshotted (the Repackaging SKU) so a locked order keeps its sheet.
--
-- Data: every part with a ship-through vendor and no other processing supplier is
-- converted to processing at a $0 fee, which keeps it on its purchase vendor's sheet
-- as well. A part that already named a DIFFERENT second vendor, or whose ship-through
-- vendor is the vendor it is bought from, is left as it is for a person to resolve (BOM
-- setup flags it). Parts with a second vendor are switched on.
-- Orders already locked are not touched. Every statement is safe to re-run.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProcessingFeeBasis') THEN
    CREATE TYPE "ProcessingFeeBasis" AS ENUM ('PER_UNIT', 'PER_ORDER');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "costPerOrder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "vendorPartNo" TEXT;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "processingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "processingFeeBasis" "ProcessingFeeBasis" NOT NULL DEFAULT 'PER_UNIT';
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "processingSku" TEXT;

-- Ship-through parts become processing parts at a $0 fee (or keep the fee already
-- recorded against that same vendor). Clearing freeIssueVendor makes a re-run a no-op.
UPDATE "Sku"
SET "secondaryVendor" = btrim("freeIssueVendor"),
    "secondaryVendorCostMinor" = CASE
      WHEN lower(btrim(coalesce("secondaryVendor", ''))) = lower(btrim("freeIssueVendor"))
        THEN coalesce("secondaryVendorCostMinor", 0)
      ELSE 0
    END,
    "processingEnabled" = true,
    "freeIssueVendor" = NULL
WHERE btrim(coalesce("freeIssueVendor", '')) <> ''
  -- Shipped "through" the vendor it is bought from is no second vendor at all; a
  -- processing line there would print the part twice on that one sheet. Left for review.
  AND lower(btrim("freeIssueVendor")) <> lower(btrim(coalesce("manufacturer", '')))
  AND (
    btrim(coalesce("secondaryVendor", '')) = ''
    OR lower(btrim("secondaryVendor")) = lower(btrim("freeIssueVendor"))
  );

-- Parts already set up with a second vendor ("Also on vendor") keep working: tick the box.
UPDATE "Sku"
SET "processingEnabled" = true
WHERE btrim(coalesce("secondaryVendor", '')) <> ''
  AND "processingEnabled" = false;

-- Manufacturer name on the flat SKU record, so parts with no Product row
-- (fasteners, third-party bits) can still carry a manufacturer in the one catalog list.
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "manufacturer" TEXT;

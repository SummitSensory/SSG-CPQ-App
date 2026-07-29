-- Builder default quantity for Additional Hardware items.
-- NULL means "no default" (the field starts at 0). 0 is an explicit "none".
-- Idempotent so a re-run or an out-of-order deploy cannot fail.
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "defaultQty" INTEGER;

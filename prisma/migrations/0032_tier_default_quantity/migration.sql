-- Builder default quantity for a tier-tree node (ProductCategory used as a
-- PRODUCT line). NULL means "no default" — the line starts blank, not 0.
-- Idempotent so a re-run or an out-of-order deploy cannot fail.
ALTER TABLE "ProductCategory" ADD COLUMN IF NOT EXISTS "defaultQuantity" INTEGER;

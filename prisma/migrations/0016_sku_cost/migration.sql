-- Unit cost on the SKU master, so proposals can report COGS and margin.
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "unitCostMinor" INTEGER NOT NULL DEFAULT 0;

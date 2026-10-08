-- 0115_catalog_indexes_and_seed_gap
--
-- Two additive changes, both safe to run against production as it stands.
--
-- 1. Plain (NON-unique) indexes on columns the catalog, vendor and purchasing screens
--    filter and join on: a vendor's parts (Sku.manufacturer), an order line's part and
--    vendor (ProcurementLine.sku / .vendor), and the foreign keys Postgres does not
--    index on its own (ProductCategory.productId, PurchaseOrder.manufacturerId,
--    FreightRfq.manufacturerId). Non-unique on purpose: production may hold part
--    numbers or vendor names that differ only in case, and a unique index would fail
--    the deploy on them.
--
-- 2. The reference rows 0029_bom_vendor_sections seeds — the Cardinal and Prismatic
--    powder brands and the Ryan Capital finance factors — re-seeded for a database
--    bootstrapped from empty. There, 0000_baseline has already created those tables,
--    so migrate-deploy.mjs marks 0029 resolved and its INSERTs never run: the BOM's
--    powder-brand picker and the financing document start with nothing. Values are
--    copied exactly from 0029. Each insert runs only when its table is EMPTY (and is
--    ON CONFLICT DO NOTHING besides), so on production — where the rows exist and may
--    since have been edited or retired in Administration — this is a no-op and never
--    brings back a row someone deleted.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfq_manufacturerId_idx" ON "FreightRfq"("manufacturerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementLine_vendor_idx" ON "ProcurementLine"("vendor");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementLine_sku_idx" ON "ProcurementLine"("sku");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductCategory_productId_idx" ON "ProductCategory"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrder_manufacturerId_idx" ON "PurchaseOrder"("manufacturerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Sku_manufacturer_idx" ON "Sku"("manufacturer");

-- Seed: powder brands (as 0029), only into an empty table.
INSERT INTO "PowderColorBrand" ("id", "name", "sortOrder", "createdAt", "updatedAt")
SELECT v."id", v."name", v."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('pcb_cardinal',  'Cardinal',  10),
  ('pcb_prismatic', 'Prismatic', 20)
) AS v("id", "name", "sortOrder")
WHERE NOT EXISTS (SELECT 1 FROM "PowderColorBrand")
ON CONFLICT DO NOTHING;

-- Seed: finance factors (as 0029), only into an empty table.
INSERT INTO "FinanceFactor" ("id", "termMonths", "factor", "sortOrder", "createdAt", "updatedAt")
SELECT v."id", v."termMonths", v."factor", v."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('ff_term_12', 12, 0.090700::DECIMAL(10,6), 10),
  ('ff_term_24', 24, 0.047080::DECIMAL(10,6), 20),
  ('ff_term_36', 36, 0.032700::DECIMAL(10,6), 30),
  ('ff_term_48', 48, 0.025530::DECIMAL(10,6), 40),
  ('ff_term_60', 60, 0.021240::DECIMAL(10,6), 50)
) AS v("id", "termMonths", "factor", "sortOrder")
WHERE NOT EXISTS (SELECT 1 FROM "FinanceFactor")
ON CONFLICT DO NOTHING;

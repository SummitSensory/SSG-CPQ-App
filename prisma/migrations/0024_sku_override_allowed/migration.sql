-- Marks which catalog parts a rep is pre-approved to substitute in the builder.
-- Default false: nothing is overridable until Catalog -> Pricing & SKUs says so.
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "overrideAllowed" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Sku_overrideAllowed_idx" ON "Sku"("overrideAllowed");

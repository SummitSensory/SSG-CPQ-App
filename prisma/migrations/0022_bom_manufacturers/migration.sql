-- 0022  Manufacturer records, product ordering, and Bill of Materials fields.
--
-- Three unrelated-looking additions that serve one screen each:
--   * Manufacturer  -> the new Catalog > Manufacturers tab (vendor of record).
--   * Product.sortOrder -> manual ordering of the default product list.
--   * AcceptedOrder / ProcurementLine -> the Bill of Materials header + lines.
-- Every column is nullable or defaulted, so this migration is safe to run on a
-- live database and needs no backfill to keep the app working.

-- ---------- Manufacturer: vendor of record ----------
ALTER TABLE "Manufacturer"
  ADD COLUMN IF NOT EXISTS "contactTitle"      TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone"      TEXT,
  ADD COLUMN IF NOT EXISTS "altContactName"    TEXT,
  ADD COLUMN IF NOT EXISTS "altContactEmail"   TEXT,
  ADD COLUMN IF NOT EXISTS "altContactPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine1"      TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine2"      TEXT,
  ADD COLUMN IF NOT EXISTS "city"              TEXT,
  ADD COLUMN IF NOT EXISTS "region"            TEXT,
  ADD COLUMN IF NOT EXISTS "postalCode"        TEXT,
  ADD COLUMN IF NOT EXISTS "country"           TEXT DEFAULT 'USA',
  ADD COLUMN IF NOT EXISTS "website"           TEXT,
  ADD COLUMN IF NOT EXISTS "accountNumber"     TEXT,
  ADD COLUMN IF NOT EXISTS "paymentTerms"      TEXT,
  ADD COLUMN IF NOT EXISTS "isSteelFabricator" BOOLEAN NOT NULL DEFAULT false;

-- The steel weight on the BOM excludes hardware and crating, so it is summed
-- from steel fabricators only. Goldberg Brothers is the known one today; any
-- other fabricator is flagged in the Manufacturers tab.
UPDATE "Manufacturer" SET "isSteelFabricator" = true WHERE lower("name") = 'goldberg brothers';

-- ---------- Product: manual list order ----------
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "Product_sortOrder_idx" ON "Product"("sortOrder");

-- ---------- Bill of Materials header ----------
DO $$ BEGIN
  CREATE TYPE "BomShipTo" AS ENUM ('CUSTOMER', 'SUMMIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AcceptedOrder"
  ADD COLUMN IF NOT EXISTS "jobName"         TEXT,
  ADD COLUMN IF NOT EXISTS "bomShipTo"       "BomShipTo" NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS "bomSubmittedOn"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveryType"    TEXT,
  ADD COLUMN IF NOT EXISTS "powderCoatBrand" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentQuote"   TEXT,
  ADD COLUMN IF NOT EXISTS "bomNotes"        TEXT;

-- ---------- Bill of Materials lines ----------
ALTER TABLE "ProcurementLine"
  ADD COLUMN IF NOT EXISTS "unitCostMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "unitWeightLbs" DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS "powderColor"   TEXT,
  ADD COLUMN IF NOT EXISTS "vendorNotes"   TEXT;

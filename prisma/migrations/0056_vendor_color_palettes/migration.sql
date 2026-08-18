-- Vendor colour palettes: colour selection for any vendor, any finish.
--
-- The Goldberg powder-coat chart (PaintColorGroup, PaintColorGroupSku,
-- PowderColorBrand) is untouched — it stays brand + code driven and part-grouped.
-- This is the general path: the vendor owns a chart of named colours, and a
-- product says how many of them it takes (1–7).

CREATE TYPE "FinishType" AS ENUM ('POWDER_COAT', 'VINYL', 'PAINT', 'OTHER');

CREATE TABLE "VendorColorPalette" (
    "id" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "finishType" "FinishType" NOT NULL DEFAULT 'VINYL',
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorColorPalette_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorColorPalette_manufacturerId_name_key"
    ON "VendorColorPalette"("manufacturerId", "name");
CREATE INDEX "VendorColorPalette_manufacturerId_idx"
    ON "VendorColorPalette"("manufacturerId");

ALTER TABLE "VendorColorPalette"
    ADD CONSTRAINT "VendorColorPalette_manufacturerId_fkey"
    FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VendorColor" (
    "id" TEXT NOT NULL,
    "paletteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendorCode" TEXT,
    "upchargeMinor" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorColor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorColor_paletteId_name_key" ON "VendorColor"("paletteId", "name");
CREATE INDEX "VendorColor_paletteId_idx" ON "VendorColor"("paletteId");

ALTER TABLE "VendorColor"
    ADD CONSTRAINT "VendorColor_paletteId_fkey"
    FOREIGN KEY ("paletteId") REFERENCES "VendorColorPalette"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductColorSpec" (
    "id" TEXT NOT NULL,
    "paletteId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "slotCount" INTEGER NOT NULL DEFAULT 1,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "slotUpchargeMinor" INTEGER,
    "slotLabels" JSONB,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductColorSpec_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductColorSpec_productId_key" ON "ProductColorSpec"("productId");
CREATE UNIQUE INDEX "ProductColorSpec_sku_key" ON "ProductColorSpec"("sku");
CREATE INDEX "ProductColorSpec_paletteId_idx" ON "ProductColorSpec"("paletteId");
CREATE INDEX "ProductColorSpec_sku_idx" ON "ProductColorSpec"("sku");

-- A spec with no target would apply to nothing and be invisible in the editor;
-- one with both targets would let two rows claim the same line.
ALTER TABLE "ProductColorSpec"
    ADD CONSTRAINT "ProductColorSpec_one_target"
    CHECK (("productId" IS NULL) <> ("sku" IS NULL));

-- Seven is the ceiling the business asked for, and it is cheaper to enforce here
-- than to discover a 40-colour product in a BOM.
ALTER TABLE "ProductColorSpec"
    ADD CONSTRAINT "ProductColorSpec_slot_count_range"
    CHECK ("slotCount" >= 1 AND "slotCount" <= 7);

ALTER TABLE "ProductColorSpec"
    ADD CONSTRAINT "ProductColorSpec_paletteId_fkey"
    FOREIGN KEY ("paletteId") REFERENCES "VendorColorPalette"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Colours chosen for a BOM line, in slot order. Denormalised name and vendor code
-- so a historic sheet still reads the same after a colour is renamed.
ALTER TABLE "ProcurementLine" ADD COLUMN "colorPicks" JSONB;

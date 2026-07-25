-- Product lines: a 4-tier product hierarchy (ProductCategory doubles as the
-- tier tree), per-product notes, and fractional-inch dimensions.
-- Every new column is nullable or defaulted; existing rows are untouched.

-- ----- Product: rename legacy whole-inch dimensions, add decimal ones -----
-- Kept (not dropped) per spec, so no historical data is lost.
ALTER TABLE "Product" RENAME COLUMN "lengthIn" TO "lengthInLegacy";
ALTER TABLE "Product" RENAME COLUMN "widthIn" TO "widthInLegacy";
ALTER TABLE "Product" RENAME COLUMN "heightIn" TO "heightInLegacy";

ALTER TABLE "Product"
  ADD COLUMN "productLineId" TEXT,
  ADD COLUMN "defaultQuantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "badge" TEXT,
  ADD COLUMN "lengthIn" DECIMAL(8,3),
  ADD COLUMN "widthIn" DECIMAL(8,3),
  ADD COLUMN "heightIn" DECIMAL(8,3),
  ADD COLUMN "thicknessIn" DECIMAL(8,3),
  ADD COLUMN "dimensionsOverride" TEXT,
  ADD COLUMN "showDimensions" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Product_productLineId_idx" ON "Product"("productLineId");

-- ----- ProductCategory: doubles as the tier tree -----
ALTER TABLE "ProductCategory"
  ADD COLUMN "productLineId" TEXT,
  ADD COLUMN "tierLevel" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "productId" TEXT;

CREATE INDEX "ProductCategory_productLineId_tierLevel_idx" ON "ProductCategory"("productLineId", "tierLevel");
CREATE INDEX "ProductCategory_parentId_sortOrder_idx" ON "ProductCategory"("parentId", "sortOrder");

-- ----- ProductLine -----
CREATE TABLE "ProductLine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductLine_name_key" ON "ProductLine"("name");
CREATE UNIQUE INDEX "ProductLine_slug_key" ON "ProductLine"("slug");

-- ----- ProductNote: the asterisked lines printed beneath a product -----
CREATE TABLE "ProductNote" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductNote_productId_idx" ON "ProductNote"("productId");
ALTER TABLE "ProductNote" ADD CONSTRAINT "ProductNote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- Foreign keys -----
ALTER TABLE "Product" ADD CONSTRAINT "Product_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

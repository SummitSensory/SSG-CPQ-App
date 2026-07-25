-- Manufacturers and per-product sourcing.
--
-- Sourcing is deliberately separate from the category tree: the BOM groups by
-- who fabricates a part (Goldberg Brothers, Resilite, TFH…), which cuts across
-- the proposal-facing tier structure. Cost stays in ProductCost as an
-- effective-dated series; nothing here duplicates it.

CREATE TABLE "Manufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isThirdParty" BOOLEAN NOT NULL DEFAULT true,
    "defaultLeadTimeDays" INTEGER,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");
CREATE UNIQUE INDEX "Manufacturer_slug_key" ON "Manufacturer"("slug");

CREATE TABLE "ProductSourcing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "vendorPartNo" TEXT,
    "leadTimeDays" INTEGER,
    "minOrderQty" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductSourcing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductSourcing_productId_manufacturerId_key" ON "ProductSourcing"("productId", "manufacturerId");
CREATE INDEX "ProductSourcing_manufacturerId_idx" ON "ProductSourcing"("manufacturerId");

ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

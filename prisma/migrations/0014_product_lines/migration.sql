-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "ProductLine_slug_key" ON "ProductLine"("slug");

-- AlterTable: tier structure on ProductCategory
ALTER TABLE "ProductCategory" ADD COLUMN "productLineId" TEXT;
ALTER TABLE "ProductCategory" ADD COLUMN "tierLevel" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ProductCategory" ADD COLUMN "productId" TEXT;

-- CreateIndex
CREATE INDEX "ProductCategory_productLineId_tierLevel_idx" ON "ProductCategory"("productLineId", "tierLevel");
CREATE INDEX "ProductCategory_parentId_idx" ON "ProductCategory"("parentId");
CREATE INDEX "ProductCategory_productId_idx" ON "ProductCategory"("productId");

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tier 1 nodes are always headers; product placements must sit at tier 2+.
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_tier_range_check" CHECK ("tierLevel" BETWEEN 1 AND 4);
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_tier1_header_check" CHECK ("tierLevel" > 1 OR "productId" IS NULL);

-- AlterTable: product presentation + dimensions
ALTER TABLE "Product" ADD COLUMN "defaultQuantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Product" ADD COLUMN "badge" TEXT;
ALTER TABLE "Product" ADD COLUMN "thicknessIn" INTEGER;
ALTER TABLE "Product" ADD COLUMN "dimensionsOverride" TEXT;
ALTER TABLE "Product" ADD COLUMN "showDimensions" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ProductNote" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ProductNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductNote_productId_idx" ON "ProductNote"("productId");

-- AddForeignKey
ALTER TABLE "ProductNote" ADD CONSTRAINT "ProductNote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Manufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contact" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");
CREATE UNIQUE INDEX "Manufacturer_code_key" ON "Manufacturer"("code");

-- CreateTable
CREATE TABLE "ProductSourcing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "vendorPartNo" TEXT,
    "leadTimeDays" INTEGER,
    "minOrderQty" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "ProductSourcing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductSourcing_productId_manufacturerId_key" ON "ProductSourcing"("productId", "manufacturerId");
CREATE INDEX "ProductSourcing_manufacturerId_idx" ON "ProductSourcing"("manufacturerId");

-- AddForeignKey
ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the Adventure Series product line.
INSERT INTO "ProductLine" ("id", "name", "slug", "description", "sortOrder", "isActive", "updatedAt")
VALUES ('pl_adventure_series', 'Adventure Series', 'adventure-series', 'Summit Sensory Gym Adventure Series', 0, true, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

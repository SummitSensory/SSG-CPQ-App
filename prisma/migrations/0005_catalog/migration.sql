CREATE TYPE "ProductKind" AS ENUM ('PRODUCT','VARIANT','COMPONENT','BUNDLE','ACCESSORY','SERVICE');
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT','ACTIVE','INACTIVE','ARCHIVED');
CREATE TYPE "RelationType" AS ENUM ('VARIANT_OF','COMPONENT_OF','BUNDLE_ITEM','ACCESSORY_OF');

CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductCategory_slug_key" ON "ProductCategory"("slug");
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProductFamily" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductFamily_categoryId_slug_key" ON "ProductFamily"("categoryId", "slug");
CREATE INDEX "ProductFamily_categoryId_idx" ON "ProductFamily"("categoryId");
ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL DEFAULT 'PRODUCT',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "categoryId" TEXT NOT NULL,
    "familyId" TEXT,
    "proposalDescription" TEXT,
    "internalDescription" TEXT,
    "lengthIn" INTEGER,
    "widthIn" INTEGER,
    "heightIn" INTEGER,
    "weightOz" INTEGER,
    "capacity" TEXT,
    "activeFrom" TIMESTAMP(3),
    "activeTo" TIMESTAMP(3),
    "adminNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX "Product_familyId_idx" ON "Product"("familyId");
CREATE INDEX "Product_status_idx" ON "Product"("status");
CREATE INDEX "Product_kind_idx" ON "Product"("kind");
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProductRelation" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductRelation_parentId_childId_type_key" ON "ProductRelation"("parentId", "childId", "type");
CREATE INDEX "ProductRelation_childId_idx" ON "ProductRelation"("childId");
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: a product used as a component/bundle member cannot be hard-deleted.
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductImage_storageKey_key" ON "ProductImage"("storageKey");
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TechnicalDocument" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "title" TEXT,
    CONSTRAINT "TechnicalDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TechnicalDocument_storageKey_key" ON "TechnicalDocument"("storageKey");
CREATE INDEX "TechnicalDocument_productId_idx" ON "TechnicalDocument"("productId");
ALTER TABLE "TechnicalDocument" ADD CONSTRAINT "TechnicalDocument_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductVersion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeNote" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductVersion_productId_version_key" ON "ProductVersion"("productId", "version");
CREATE INDEX "ProductVersion_productId_idx" ON "ProductVersion"("productId");
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductStatusHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromStatus" "ProductStatus",
    "toStatus" "ProductStatus" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductStatusHistory_productId_idx" ON "ProductStatusHistory"("productId");
ALTER TABLE "ProductStatusHistory" ADD CONSTRAINT "ProductStatusHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "PriceListStatus" AS ENUM ('DRAFT','ACTIVE','ARCHIVED');

CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PriceListStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceList_status_idx" ON "PriceList"("status");
CREATE INDEX "PriceList_effectiveDate_idx" ON "PriceList"("effectiveDate");

CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PriceListEntry_priceListId_productId_minQuantity_key" ON "PriceListEntry"("priceListId", "productId", "minQuantity");
CREATE INDEX "PriceListEntry_productId_idx" ON "PriceListEntry"("productId");
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerPrice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),
    CONSTRAINT "CustomerPrice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerPrice_organizationId_productId_idx" ON "CustomerPrice"("organizationId", "productId");

CREATE TABLE "PromotionalPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "code" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),
    CONSTRAINT "PromotionalPrice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PromotionalPrice_productId_idx" ON "PromotionalPrice"("productId");

CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductCost_productId_effectiveDate_idx" ON "ProductCost"("productId", "effectiveDate");

CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "subjectRef" TEXT,
    "currency" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "ruleSnapshotId" TEXT,
    "input" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "grandTotal" BIGINT NOT NULL,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceSnapshot_subjectRef_idx" ON "PriceSnapshot"("subjectRef");

CREATE TABLE "PriceOverrideLog" (
    "id" TEXT NOT NULL,
    "subjectRef" TEXT,
    "field" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceOverrideLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceOverrideLog_subjectRef_idx" ON "PriceOverrideLog"("subjectRef");

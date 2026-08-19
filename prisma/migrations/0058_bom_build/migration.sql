-- BOM build rules: kit components and free-issue parts.
--
-- Additive and idempotent. With no SkuComponent rows and no Sku.freeIssueVendor set,
-- a Bill of Materials is built exactly as it was before this migration.

ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "keepParentOnBom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "freeIssueVendor" TEXT;

ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "freeIssue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProcurementLine" ADD COLUMN IF NOT EXISTS "purchaseVendor" TEXT;

CREATE TABLE IF NOT EXISTS "SkuComponent" (
    "id" TEXT NOT NULL,
    "parentPart" TEXT NOT NULL,
    "childPart" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SkuComponent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SkuComponent_parentPart_childPart_key" ON "SkuComponent"("parentPart", "childPart");
CREATE INDEX IF NOT EXISTS "SkuComponent_parentPart_idx" ON "SkuComponent"("parentPart");
CREATE INDEX IF NOT EXISTS "SkuComponent_childPart_idx" ON "SkuComponent"("childPart");

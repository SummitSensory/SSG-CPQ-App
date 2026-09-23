-- 0098_portal_order_items
--
-- Customer-portal tracking for the Orders & Bill of Materials page: one row per
-- order per portal step (delivery, colour, billing, contact, required) with the
-- date the customer's answers were obtained and who reviewed them; an admin table
-- mapping portal colour areas to catalog parts; the extra delivery-submission
-- fields the Bill of Materials now prints (submitted date, preferred communication,
-- text numbers); and a PORTAL marker on CRM addresses so a customer-confirmed ship-to
-- is added once per order and corrected in place on resubmission.
--
-- Additive only: new types, tables, columns and indexes. Nothing is dropped or
-- altered. Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs
-- on every deploy and a half-applied migration must be repairable by running it again.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PortalItemKind') THEN
    CREATE TYPE "PortalItemKind" AS ENUM ('DELIVERY', 'COLOR', 'BILLING', 'CONTACT', 'REQUIRED');
  END IF;
END $$;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PortalItemState') THEN
    CREATE TYPE "PortalItemState" AS ENUM ('NOT_PROVIDED', 'NA', 'PROVIDED');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "sourceOrderId" TEXT;

-- AlterTable
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "crmAddressId" TEXT;
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "preferredComm" TEXT;
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "secondaryMobile" TEXT;
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "secondaryPreferredComm" TEXT;
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "submittedDate" TIMESTAMP(3);
ALTER TABLE "PortalDeliverySubmission" ADD COLUMN IF NOT EXISTS "textNumber" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderPortalItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "PortalItemKind" NOT NULL,
    "state" "PortalItemState" NOT NULL DEFAULT 'NOT_PROVIDED',
    "mondayStatus" TEXT,
    "answers" JSONB,
    "contentHash" TEXT,
    "obtainedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedHash" TEXT,
    "sourceItemId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPortalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PortalColorAreaMapping" (
    "id" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalColorAreaMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderPortalItem_kind_state_idx" ON "OrderPortalItem"("kind", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "OrderPortalItem_orderId_kind_key" ON "OrderPortalItem"("orderId", "kind");
CREATE INDEX IF NOT EXISTS "PortalColorAreaMapping_areaKey_idx" ON "PortalColorAreaMapping"("areaKey");
CREATE UNIQUE INDEX IF NOT EXISTS "PortalColorAreaMapping_areaKey_sku_key" ON "PortalColorAreaMapping"("areaKey", "sku");
CREATE INDEX IF NOT EXISTS "Address_sourceOrderId_idx" ON "Address"("sourceOrderId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderPortalItem_orderId_fkey') THEN
    ALTER TABLE "OrderPortalItem" ADD CONSTRAINT "OrderPortalItem_orderId_fkey" FOREIGN KEY ("orderId")
      REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

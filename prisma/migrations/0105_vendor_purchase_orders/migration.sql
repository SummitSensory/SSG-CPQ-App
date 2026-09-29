-- 0105_vendor_purchase_orders
--
-- Generated from the difference between prisma/schema.prisma and the database.
-- Purchase orders to vendors, raised from a locked order's Bill of Materials:
-- a per-vendor switch (and send-dialog defaults) on Manufacturer, and the PO, its
-- lines and its email sends.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PurchaseOrderStatus') THEN
  CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "poEmailBody" TEXT,
ADD COLUMN IF NOT EXISTS "poEmailCc" TEXT,
ADD COLUMN IF NOT EXISTS "poEmailSubject" TEXT,
ADD COLUMN IF NOT EXISTS "poEmailTo" TEXT,
ADD COLUMN IF NOT EXISTS "poEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "manufacturerId" TEXT,
    "projectId" TEXT NOT NULL,
    "vendorAbbrev" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "reference" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "freightMinor" INTEGER,
    "noFreightCharge" BOOLEAN NOT NULL DEFAULT false,
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "shipToName" TEXT NOT NULL,
    "shipToLines" TEXT[],
    "contactName" TEXT,
    "contactPhone" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "mondayResult" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "vendorSku" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,
    "extendedCostMinor" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseOrderSend" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmails" TEXT,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT NOT NULL,
    "status" "FreightRfqSendStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_reference_key" ON "PurchaseOrder"("reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrder_orderId_idx" ON "PurchaseOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_orderId_vendor_sequence_key" ON "PurchaseOrder"("orderId", "vendor", "sequence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_poId_idx" ON "PurchaseOrderLine"("poId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrderSend_poId_idx" ON "PurchaseOrderSend"("poId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseOrderSend_providerMessageId_idx" ON "PurchaseOrderSend"("providerMessageId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrder_orderId_fkey') THEN
    ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrder_manufacturerId_fkey') THEN
    ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderLine_poId_fkey') THEN
    ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderSend_poId_fkey') THEN
    ALTER TABLE "PurchaseOrderSend" ADD CONSTRAINT "PurchaseOrderSend_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

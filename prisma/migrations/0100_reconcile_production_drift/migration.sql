-- Reconcile production with schema.prisma.
--
-- Since at least 2026-09-23 the production drift check (migrate.yml, Vercel build)
-- has reported these as missing in production, though schema.prisma declares them
-- and the migrations that introduced them exist (0024, 0042, 0046, 0063, 0064 and the
-- tables' CREATE migrations). A database built by replaying the history has them;
-- production does not. Every statement is idempotent, so this is a no-op anywhere
-- they already exist.

-- @updatedAt columns declared @default(now()).
ALTER TABLE "FreightEntry" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PaymentTemplate" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PortalColorSelection" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PortalDeliverySubmission" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "UiSetting" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Declared @@index([...]) in schema.prisma.
CREATE INDEX IF NOT EXISTS "AcceptedOrder_manufacturingReleasedAt_idx" ON "AcceptedOrder"("manufacturingReleasedAt");
CREATE INDEX IF NOT EXISTS "Organization_followUpDate_idx" ON "Organization"("followUpDate");
CREATE INDEX IF NOT EXISTS "ProcurementLine_invoicedAt_idx" ON "ProcurementLine"("invoicedAt");
CREATE INDEX IF NOT EXISTS "Sku_overrideAllowed_idx" ON "Sku"("overrideAllowed");

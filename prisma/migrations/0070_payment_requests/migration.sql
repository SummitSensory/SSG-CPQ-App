-- 0070_payment_requests
--
-- Invoice balances read back from QuickBooks, the customer's purchase order, and
-- the payment-request email sent from a rep's own Outlook mailbox.
--
-- Every statement is guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- ---------------------------------------------------------------- QboTransaction
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "initialTotalMinor" BIGINT;
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "invoiceDate" TIMESTAMP(3);
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "qboInvoiceLink" TEXT;
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "poPushedValue" TEXT;
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "poPushedAt" TIMESTAMP(3);
ALTER TABLE "QboTransaction" ADD COLUMN IF NOT EXISTS "poNeedsPush" BOOLEAN NOT NULL DEFAULT false;

-- Seed the initial total from what we already hold. For an invoice created before
-- this migration the current total is the best available record of what the
-- customer was first billed; leaving it null would show "—" on every existing row.
UPDATE "QboTransaction"
   SET "initialTotalMinor" = "qboTotalMinor"
 WHERE "initialTotalMinor" IS NULL
   AND "qboTotalMinor" IS NOT NULL;

-- ------------------------------------------------------------------- templates
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentTemplateKind') THEN
    CREATE TYPE "PaymentTemplateKind" AS ENUM ('EMAIL', 'LETTER');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PaymentTemplate" (
  "id"          TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "kind"        "PaymentTemplateKind" NOT NULL,
  "name"        TEXT NOT NULL,
  "stage"       INTEGER NOT NULL DEFAULT 1,
  "whenToUse"   TEXT,
  "subject"     TEXT NOT NULL,
  "bodyHtml"    TEXT NOT NULL,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "isBuiltIn"   BOOLEAN NOT NULL DEFAULT false,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTemplate_key_key" ON "PaymentTemplate"("key");
CREATE INDEX IF NOT EXISTS "PaymentTemplate_kind_active_stage_idx"
  ON "PaymentTemplate"("kind", "active", "stage");

-- ------------------------------------------------------------ customer PO files
CREATE TABLE IF NOT EXISTS "CustomerPurchaseOrderFile" (
  "id"             TEXT NOT NULL,
  "orderId"        TEXT NOT NULL,
  "organizationId" TEXT,
  "filename"       TEXT NOT NULL,
  "contentType"    TEXT NOT NULL,
  "byteSize"       INTEGER NOT NULL,
  "url"            TEXT NOT NULL,
  "pathname"       TEXT NOT NULL,
  "poNumber"       TEXT,
  "uploadedById"   TEXT NOT NULL,
  "uploadedByName" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerPurchaseOrderFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CustomerPurchaseOrderFile_orderId_createdAt_idx"
  ON "CustomerPurchaseOrderFile"("orderId", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerPurchaseOrderFile_organizationId_idx"
  ON "CustomerPurchaseOrderFile"("organizationId");

-- -------------------------------------------------------------- sent-email log
CREATE TABLE IF NOT EXISTS "PaymentRequestEmail" (
  "id"                 TEXT NOT NULL,
  "qboTransactionId"   TEXT NOT NULL,
  "organizationId"     TEXT,
  "orderId"            TEXT,
  "mailbox"            TEXT NOT NULL,
  "toEmail"            TEXT NOT NULL,
  "ccEmail"            TEXT,
  "subject"            TEXT NOT NULL,
  "bodyHtml"           TEXT NOT NULL,
  "emailTemplateKey"   TEXT,
  "letterTemplateKey"  TEXT,
  "letterTemplateName" TEXT,
  "attachedInvoicePdf" BOOLEAN NOT NULL DEFAULT false,
  "attachedLetterPdf"  BOOLEAN NOT NULL DEFAULT false,
  "attachedPoFileIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "balanceMinor"       BIGINT NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'USD',
  "mergeValues"        JSONB NOT NULL,
  "graphMessageId"     TEXT,
  "status"             TEXT NOT NULL,
  "error"              TEXT,
  "sentById"           TEXT NOT NULL,
  "sentByName"         TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentRequestEmail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PaymentRequestEmail_qboTransactionId_createdAt_idx"
  ON "PaymentRequestEmail"("qboTransactionId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaymentRequestEmail_organizationId_createdAt_idx"
  ON "PaymentRequestEmail"("organizationId", "createdAt");

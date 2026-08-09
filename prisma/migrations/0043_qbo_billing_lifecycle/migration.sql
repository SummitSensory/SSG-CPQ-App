-- QuickBooks billing lifecycle: delivery, payments and reminders.
--
-- Everything added here mirrors QuickBooks-owned state (see
-- src/integrations/quickbooks/source-of-truth.ts). No CPQ financial column is
-- touched, so this migration cannot alter an accepted total. Every new column
-- is nullable or defaulted, so existing QboTransaction rows stay valid and
-- simply read as "never synced" until the first refresh fills them in.

-- ---- QboTransaction: delivery + accounting state ----
ALTER TABLE "QboTransaction"
  ADD COLUMN "emailStatus"       TEXT,
  ADD COLUMN "sentAt"            TIMESTAMP(3),
  ADD COLUMN "sentToEmail"       TEXT,
  ADD COLUMN "sentById"          TEXT,
  ADD COLUMN "lastSendAttemptAt" TIMESTAMP(3),
  ADD COLUMN "sendError"         TEXT,
  ADD COLUMN "dueDate"           TIMESTAMP(3),
  ADD COLUMN "qboTotalMinor"     BIGINT,
  ADD COLUMN "balanceMinor"      BIGINT,
  ADD COLUMN "paidMinor"         BIGINT,
  ADD COLUMN "qboStatus"         TEXT,
  ADD COLUMN "qboLastSyncedAt"   TIMESTAMP(3);

CREATE INDEX "QboTransaction_qboStatus_idx" ON "QboTransaction"("qboStatus");
CREATE INDEX "QboTransaction_sentAt_idx"    ON "QboTransaction"("sentAt");

-- ---- QboPayment: payments read back from QuickBooks ----
CREATE TABLE "QboPayment" (
  "id"               TEXT NOT NULL,
  "environment"      "QboEnvironment" NOT NULL,
  "qboPaymentId"     TEXT NOT NULL,
  "qboTransactionId" TEXT NOT NULL,
  "customerQboId"    TEXT,
  "amountMinor"      BIGINT NOT NULL,
  "totalAmountMinor" BIGINT NOT NULL,
  "unappliedMinor"   BIGINT NOT NULL DEFAULT 0,
  "currency"         TEXT NOT NULL DEFAULT 'USD',
  "method"           TEXT,
  "referenceNumber"  TEXT,
  "depositToAccount" TEXT,
  "txnDate"          TIMESTAMP(3) NOT NULL,
  "qboCreatedAt"     TIMESTAMP(3),
  "qboUpdatedAt"     TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QboPayment_pkey" PRIMARY KEY ("id")
);

-- One row per (payment, invoice) pair: a cheque split across three invoices is
-- three rows, and re-reading it must update them rather than duplicate them.
CREATE UNIQUE INDEX "QboPayment_environment_qboPaymentId_qboTransactionId_key"
  ON "QboPayment"("environment", "qboPaymentId", "qboTransactionId");
CREATE INDEX "QboPayment_qboTransactionId_idx" ON "QboPayment"("qboTransactionId");
CREATE INDEX "QboPayment_customerQboId_idx"    ON "QboPayment"("customerQboId");

ALTER TABLE "QboPayment"
  ADD CONSTRAINT "QboPayment_qboTransactionId_fkey"
  FOREIGN KEY ("qboTransactionId") REFERENCES "QboTransaction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---- PaymentReminder: correspondence log ----
CREATE TABLE "PaymentReminder" (
  "id"               TEXT NOT NULL,
  "qboTransactionId" TEXT NOT NULL,
  "organizationId"   TEXT,
  "toEmail"          TEXT NOT NULL,
  "ccEmail"          TEXT,
  "subject"          TEXT NOT NULL,
  "body"             TEXT NOT NULL,
  "balanceMinor"     BIGINT NOT NULL,
  "currency"         TEXT NOT NULL DEFAULT 'USD',
  "attachedInvoice"  BOOLEAN NOT NULL DEFAULT true,
  "status"           TEXT NOT NULL,
  "error"            TEXT,
  "sentById"         TEXT NOT NULL,
  "sentByName"       TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentReminder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentReminder_qboTransactionId_createdAt_idx"
  ON "PaymentReminder"("qboTransactionId", "createdAt");
CREATE INDEX "PaymentReminder_organizationId_createdAt_idx"
  ON "PaymentReminder"("organizationId", "createdAt");

ALTER TABLE "PaymentReminder"
  ADD CONSTRAINT "PaymentReminder_qboTransactionId_fkey"
  FOREIGN KEY ("qboTransactionId") REFERENCES "QboTransaction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

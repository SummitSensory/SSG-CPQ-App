-- Internal notes that live with the customer, and the two customer-level dates.
--
-- The notes are a running log rather than an editable field: nothing is overwritten,
-- so the account history survives both the proposal and the person who wrote it.
-- "proposalId" records which proposal a note was written from and is intentionally
-- NOT a foreign key — a deleted or rejected proposal must leave its notes behind on
-- the customer rather than take them with it.
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "proposalId" TEXT,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- The panel reads one customer's log newest-first, and splits it by proposal.
CREATE INDEX "CustomerNote_organizationId_createdAt_idx" ON "CustomerNote"("organizationId", "createdAt");
CREATE INDEX "CustomerNote_proposalId_idx" ON "CustomerNote"("proposalId");

ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ideal decision timeline (a range) and the next planned contact. On the customer,
-- not the proposal: they describe the relationship and outlive any one quote.
ALTER TABLE "Organization" ADD COLUMN "decisionFrom" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "decisionTo" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "followUpDate" TIMESTAMP(3);

-- The dashboard asks "whose follow-up is due?" across every customer at once.
CREATE INDEX "Organization_followUpDate_idx" ON "Organization"("followUpDate");

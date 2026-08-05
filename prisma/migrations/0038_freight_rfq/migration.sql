-- Freight RFQ: per-vendor requests for freight costs raised from a proposal.

-- ---------------------------------------------------------------- vendors ---
ALTER TABLE "Manufacturer"
  ADD COLUMN "rfqEnabled"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rfqContactName"   TEXT,
  ADD COLUMN "rfqContactEmail"  TEXT,
  ADD COLUMN "rfqContactPhone"  TEXT,
  ADD COLUMN "rfqEmailTo"       TEXT,
  ADD COLUMN "rfqEmailCc"       TEXT,
  ADD COLUMN "rfqEmailSubject"  TEXT,
  ADD COLUMN "rfqEmailBody"     TEXT;

-- ------------------------------------------------------------------ enums ---
CREATE TYPE "FreightRfqStatus"     AS ENUM ('DRAFT', 'SENT', 'SUPERSEDED');
CREATE TYPE "FreightRfqSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- ------------------------------------------------------------------- rfqs ---
CREATE TABLE "FreightRfq" (
  "id"             TEXT NOT NULL,
  "proposalId"     TEXT NOT NULL,
  "versionId"      TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "vendor"         TEXT NOT NULL,
  "manufacturerId" TEXT,
  "projectId"      TEXT NOT NULL,
  "reference"      TEXT NOT NULL,
  "revision"       INTEGER NOT NULL DEFAULT 1,
  "notes"          TEXT,
  "status"         "FreightRfqStatus" NOT NULL DEFAULT 'DRAFT',
  "shipToName"     TEXT NOT NULL,
  "shipToLine1"    TEXT,
  "shipToLine2"    TEXT,
  "shipToCity"     TEXT,
  "shipToRegion"   TEXT,
  "shipToPostal"   TEXT,
  "shipToCountry"  TEXT,
  "contactName"    TEXT,
  "contactPhone"   TEXT,
  "totalCostMinor" INTEGER NOT NULL DEFAULT 0,
  "sentAt"         TIMESTAMP(3),
  "sentById"       TEXT,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FreightRfq_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FreightRfq_proposalId_vendor_revision_key"
  ON "FreightRfq" ("proposalId", "vendor", "revision");
CREATE INDEX "FreightRfq_versionId_idx"      ON "FreightRfq" ("versionId");
CREATE INDEX "FreightRfq_organizationId_idx" ON "FreightRfq" ("organizationId");
CREATE INDEX "FreightRfq_status_idx"         ON "FreightRfq" ("status");

ALTER TABLE "FreightRfq"
  ADD CONSTRAINT "FreightRfq_proposalId_fkey"
  FOREIGN KEY ("proposalId") REFERENCES "Proposal" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FreightRfq"
  ADD CONSTRAINT "FreightRfq_manufacturerId_fkey"
  FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------------------ lines ---
CREATE TABLE "FreightRfqLine" (
  "id"                TEXT NOT NULL,
  "rfqId"             TEXT NOT NULL,
  "sku"               TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "quantity"          INTEGER NOT NULL DEFAULT 1,
  "unitCostMinor"     INTEGER NOT NULL DEFAULT 0,
  "extendedCostMinor" INTEGER NOT NULL DEFAULT 0,
  "included"          BOOLEAN NOT NULL DEFAULT true,
  "addedManually"     BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"         INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "FreightRfqLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FreightRfqLine_rfqId_idx" ON "FreightRfqLine" ("rfqId");

ALTER TABLE "FreightRfqLine"
  ADD CONSTRAINT "FreightRfqLine_rfqId_fkey"
  FOREIGN KEY ("rfqId") REFERENCES "FreightRfq" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ sends ---
CREATE TABLE "FreightRfqSend" (
  "id"                TEXT NOT NULL,
  "rfqId"             TEXT NOT NULL,
  "toEmail"           TEXT NOT NULL,
  "ccEmails"          TEXT,
  "subject"           TEXT NOT NULL,
  "bodyPreview"       TEXT NOT NULL,
  "status"            "FreightRfqSendStatus" NOT NULL DEFAULT 'QUEUED',
  "providerMessageId" TEXT,
  "error"             TEXT,
  "sentById"          TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FreightRfqSend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FreightRfqSend_rfqId_idx" ON "FreightRfqSend" ("rfqId");

ALTER TABLE "FreightRfqSend"
  ADD CONSTRAINT "FreightRfqSend_rfqId_fkey"
  FOREIGN KEY ("rfqId") REFERENCES "FreightRfq" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

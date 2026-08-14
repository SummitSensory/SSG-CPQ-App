-- Freight true-up: the sanctioned post-release change to a frozen proposal.
--
-- Additive only. One new table and two new enums; nothing existing is altered,
-- so this is safe to apply to production ahead of the code that reads it.

CREATE TYPE "FreightTrueUpStatus" AS ENUM ('OPEN', 'STAGED', 'APPLIED', 'VOID');
CREATE TYPE "FreightInvoiceMode" AS ENUM ('AMEND', 'SUPPLEMENT');

CREATE TABLE "FreightTrueUp" (
  "id"                    TEXT NOT NULL,
  "proposalId"            TEXT NOT NULL,
  "versionId"             TEXT NOT NULL,
  "status"                "FreightTrueUpStatus" NOT NULL DEFAULT 'OPEN',

  "structureFreightMinor" INTEGER,
  "stdFreightMinor"       INTEGER,
  "thirdPartyLines"       JSONB,
  "thirdPartyTotalMinor"  INTEGER,

  "vendorName"            TEXT,
  "vendorQuoteRef"        TEXT,
  "quoteAttachmentId"     TEXT,
  "freightRfqId"          TEXT,
  "note"                  TEXT,
  "noFreightReason"       TEXT,

  "appliedAt"             TIMESTAMP(3),
  "appliedById"           TEXT,
  "previousTotalMinor"    BIGINT,
  "newTotalMinor"         BIGINT,
  "previousSnapshotId"    TEXT,
  "newSnapshotId"         TEXT,

  "qboMode"               "FreightInvoiceMode",
  "qboSourceTxnId"        TEXT,
  "qboSupplementTxnId"    TEXT,
  "qboPreviousTotalMinor" BIGINT,
  "qboNewTotalMinor"      BIGINT,
  "qboPushedAt"           TIMESTAMP(3),
  "qboPushedById"         TEXT,
  "qboError"              TEXT,

  "customerNotifiedAt"    TIMESTAMP(3),
  "customerNotifiedById"  TEXT,

  "createdById"           TEXT NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FreightTrueUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FreightTrueUp_proposalId_idx" ON "FreightTrueUp"("proposalId");
CREATE INDEX "FreightTrueUp_versionId_idx" ON "FreightTrueUp"("versionId");
CREATE INDEX "FreightTrueUp_status_idx" ON "FreightTrueUp"("status");

ALTER TABLE "FreightTrueUp"
  ADD CONSTRAINT "FreightTrueUp_proposalId_fkey"
  FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

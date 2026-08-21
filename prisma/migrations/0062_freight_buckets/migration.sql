-- Freight, four buckets.
--
-- Additive only: three new enums, one new table, two new columns on
-- "FreightTrueUp". No column is dropped, altered or renamed, so this is safe to
-- apply ahead of the code — the running application ignores what it does not know
-- about, and rows written under the old three-bucket model keep their money where
-- it is (structureFreightMinor is steel, stdFreightMinor is other).
--
-- The four buckets are STEEL, MATS, THERAPEUTIC and OTHER. The first two are read
-- off the monday deal board, the last two are entered by hand.

-- ---------------------------------------------------------------- enums

DO $$ BEGIN
  CREATE TYPE "FreightBucketKind" AS ENUM ('STEEL', 'MATS', 'THERAPEUTIC', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FreightEntrySource" AS ENUM ('MONDAY', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FreightEntryScope" AS ENUM ('JOB', 'LINES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FreightEntryStatus" AS ENUM ('STAGED', 'APPLIED', 'PUSHED', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------- the alert acknowledgement
--
-- The "this invoice is short of freight" banner can be dismissed so the screen
-- underneath is readable. It cannot be dismissed permanently: the acknowledgement
-- is quiet for a day and then the banner returns.

ALTER TABLE "FreightTrueUp" ADD COLUMN IF NOT EXISTS "alertAckAt" TIMESTAMP(3);
ALTER TABLE "FreightTrueUp" ADD COLUMN IF NOT EXISTS "alertAckById" TEXT;

-- ---------------------------------------------------------------- entries

CREATE TABLE IF NOT EXISTS "FreightEntry" (
  "id"                TEXT NOT NULL,
  "trueUpId"          TEXT NOT NULL,
  "proposalId"        TEXT NOT NULL,
  "versionId"         TEXT NOT NULL,

  "bucket"            "FreightBucketKind" NOT NULL,
  "scope"             "FreightEntryScope" NOT NULL,
  "source"            "FreightEntrySource" NOT NULL,
  "status"            "FreightEntryStatus" NOT NULL DEFAULT 'STAGED',

  "amountMinor"       INTEGER NOT NULL,
  "allocations"       JSONB,

  "vendorName"        TEXT,
  "vendorQuoteRef"    TEXT,
  "quoteAttachmentId" TEXT,
  "description"       TEXT,
  "overrideReason"    TEXT,
  "note"              TEXT,

  "mondayItemId"      TEXT,
  "mondayColumnId"    TEXT,
  "mondayRawValue"    TEXT,
  "mondayReadAt"      TIMESTAMP(3),

  "appliedAt"         TIMESTAMP(3),
  "appliedById"       TEXT,

  "qboMode"           "FreightInvoiceMode",
  "qboTxnId"          TEXT,
  "qboDocNumber"      TEXT,
  "qboPushedAt"       TIMESTAMP(3),
  "qboPushedById"     TEXT,

  "voidReason"        TEXT,

  "createdById"       TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FreightEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FreightEntry_trueUpId_idx"          ON "FreightEntry" ("trueUpId");
CREATE INDEX IF NOT EXISTS "FreightEntry_proposalId_idx"        ON "FreightEntry" ("proposalId");
CREATE INDEX IF NOT EXISTS "FreightEntry_versionId_bucket_idx"  ON "FreightEntry" ("versionId", "bucket");
CREATE INDEX IF NOT EXISTS "FreightEntry_status_idx"            ON "FreightEntry" ("status");

DO $$ BEGIN
  ALTER TABLE "FreightEntry"
    ADD CONSTRAINT "FreightEntry_trueUpId_fkey"
    FOREIGN KEY ("trueUpId") REFERENCES "FreightTrueUp" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "FreightEntry"
    ADD CONSTRAINT "FreightEntry_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "Proposal" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One live monday-sourced entry per bucket per version. A board column holds one
-- figure, so a second unapplied row reading the same column is a duplicate, not a
-- second shipment — the sync updates in place instead of stacking. Applied and
-- pushed rows are excluded: those are history, and a corrected figure that arrives
-- after billing is a new row on purpose.
CREATE UNIQUE INDEX IF NOT EXISTS "FreightEntry_live_monday_bucket_key"
  ON "FreightEntry" ("versionId", "bucket")
  WHERE "source" = 'MONDAY' AND "status" = 'STAGED';

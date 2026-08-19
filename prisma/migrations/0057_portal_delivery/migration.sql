-- Migration 0057 — portal delivery details into the BOM, and the portal colour
-- selection path (built, gated off).
--
-- Safe to run on a live database: every change is additive. No column is
-- dropped, no existing row is rewritten, and nothing here is required by code
-- that is already deployed.

-- ---------------------------------------------------------------------------
-- Portal delivery submissions — idempotency key, parking table, and the record
-- of what the customer actually said.
-- ---------------------------------------------------------------------------

CREATE TYPE "PortalSubmissionStatus" AS ENUM (
  'INCOMPLETE',
  'PARKED',
  'APPLIED',
  'CONFLICT',
  'FAILED'
);

CREATE TABLE "PortalDeliverySubmission" (
  "id"                    TEXT NOT NULL,
  "mondayItemId"          TEXT NOT NULL,
  "mondayOrderItemId"     TEXT NOT NULL,
  "orderId"               TEXT,
  "shipToAddressId"       TEXT,
  "status"                "PortalSubmissionStatus" NOT NULL DEFAULT 'INCOMPLETE',
  "sectionsUpdated"       INTEGER NOT NULL DEFAULT 0,
  "skippedVendors"        TEXT,
  "note"                  TEXT,
  "customerEmail"         TEXT,
  "addressConfirmed"      BOOLEAN,
  "line1"                 TEXT,
  "line2"                 TEXT,
  "city"                  TEXT,
  "region"                TEXT,
  "postalCode"            TEXT,
  "country"               TEXT,
  "formattedAddress"      TEXT,
  "pocName"               TEXT,
  "pocPhone"              TEXT,
  "pocEmail"              TEXT,
  "secondaryPocName"      TEXT,
  "secondaryPocPhone"     TEXT,
  "secondaryPocEmail"     TEXT,
  "loadingDock"           TEXT,
  "deliveryTiming"        TEXT,
  "preferredDeliveryDate" TIMESTAMP(3),
  "specialInstructions"   TEXT,
  "restrictedChanges"     TEXT,
  "freightAckBy"          TEXT,
  "freightAckDate"        TIMESTAMP(3),
  "raw"                   JSONB,
  "attempts"              INTEGER NOT NULL DEFAULT 0,
  "receivedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"            TIMESTAMP(3),
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PortalDeliverySubmission_pkey" PRIMARY KEY ("id")
);

-- The idempotency key. One row on the submissions board is processed once,
-- however many column-change events monday fires for it.
CREATE UNIQUE INDEX "PortalDeliverySubmission_mondayItemId_key"
  ON "PortalDeliverySubmission" ("mondayItemId");

CREATE INDEX "PortalDeliverySubmission_mondayOrderItemId_idx"
  ON "PortalDeliverySubmission" ("mondayOrderItemId");
CREATE INDEX "PortalDeliverySubmission_status_idx"
  ON "PortalDeliverySubmission" ("status");
CREATE INDEX "PortalDeliverySubmission_orderId_idx"
  ON "PortalDeliverySubmission" ("orderId");

-- SET NULL, not CASCADE: a cancelled order must not erase the record of what the
-- customer told us.
ALTER TABLE "PortalDeliverySubmission"
  ADD CONSTRAINT "PortalDeliverySubmission_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PortalDeliverySubmission"
  ADD CONSTRAINT "PortalDeliverySubmission_shipToAddressId_fkey"
  FOREIGN KEY ("shipToAddressId") REFERENCES "ShipToAddress" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The three delivery answers the portal collects that the BOM had nowhere to
-- put. Separate columns rather than appended onto `deliveryType`, which is a
-- free-text field a human writes.
-- ---------------------------------------------------------------------------

ALTER TABLE "BomVendorSection"
  ADD COLUMN "loadingDock"           TEXT,
  ADD COLUMN "deliveryTiming"        TEXT,
  ADD COLUMN "preferredDeliveryDate" TIMESTAMP(3);

-- The Manufacturing Process board row this order corresponds to.
--
-- NOT the same id as `mondayProjectId`, which is the Deal Tracking row. The portal
-- lives on the manufacturing board and knows only that id, so without a recorded
-- link there is no join between a portal submission and a CRM order. Written the
-- first time a submission is matched (by hand or by the email ladder), after which
-- every later submission for the order resolves on this column alone.
ALTER TABLE "AcceptedOrder"
  ADD COLUMN "portalOrderItemId" TEXT;

CREATE UNIQUE INDEX "AcceptedOrder_portalOrderItemId_key"
  ON "AcceptedOrder" ("portalOrderItemId");

-- Where an address came from. NULL means hand-typed, which is every existing row.
ALTER TABLE "ShipToAddress"
  ADD COLUMN "source" TEXT;

-- Which address the RFQ's frozen ship-to fields were resolved from.
-- Backfilled as ORG for existing rows: that is factually what they used.
ALTER TABLE "FreightRfq"
  ADD COLUMN "shipToSource" TEXT;

UPDATE "FreightRfq" SET "shipToSource" = 'ORG' WHERE "shipToSource" IS NULL;

-- ---------------------------------------------------------------------------
-- Portal colour selection. The tables exist so the path can be exercised on a
-- real order in shadow mode; PORTAL_COLOR_SELECTION gates whether anything is
-- ever written onto a procurement line.
-- ---------------------------------------------------------------------------

CREATE TYPE "PortalColorSelectionStatus" AS ENUM (
  'OPEN',
  'SUBMITTED',
  'APPLIED',
  'SHADOWED',
  'VOID'
);

CREATE TABLE "PortalColorSelection" (
  "id"                TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "mondayOrderItemId" TEXT,
  "tokenHash"         TEXT NOT NULL,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "status"            "PortalColorSelectionStatus" NOT NULL DEFAULT 'OPEN',
  "offered"           JSONB,
  "picks"             JSONB,
  "submittedAt"       TIMESTAMP(3),
  "submittedByEmail"  TEXT,
  "appliedAt"         TIMESTAMP(3),
  "appliedById"       TEXT,
  "note"              TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"       TEXT,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PortalColorSelection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalColorSelection_tokenHash_key"
  ON "PortalColorSelection" ("tokenHash");
CREATE INDEX "PortalColorSelection_orderId_idx"
  ON "PortalColorSelection" ("orderId");
CREATE INDEX "PortalColorSelection_status_idx"
  ON "PortalColorSelection" ("status");

ALTER TABLE "PortalColorSelection"
  ADD CONSTRAINT "PortalColorSelection_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

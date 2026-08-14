-- Administration + operations changes, August 2026.
--
-- Four unrelated asks share one migration because they ship together:
--
--   1. Formula revision log. Every frame/hardware/business-number change is
--      recorded with a FULL before and after snapshot, not just the fields that
--      were sent. Undo needs the before state, and the existing AuditLog rows
--      only carry the new values — so a new table rather than a re-read of audit.
--   2. Manufacturing release. "Proposal Signed" now creates the operational
--      order, and releasing it to production is a separate, later act that is
--      gated on a QuickBooks invoice existing (or being deliberately waived).
--   3. BOM quantity override. ProcurementLine.quantity is already the editable
--      operational figure; what was missing is a record of what the formula
--      produced, so an edited line can be badged and the original recovered.
--   4. Nothing is dropped or re-typed. Additive only — safe to apply ahead of
--      the code that reads it.

CREATE TYPE "FormulaRevisionKind" AS ENUM ('FRAME', 'HARDWARE', 'SETTING');
CREATE TYPE "FormulaRevisionAction" AS ENUM ('CREATE', 'UPDATE', 'RESET', 'RESET_ALL', 'UNDO');

-- ---------------- 1. Formula revision log ----------------

CREATE TABLE "FormulaRevision" (
  "id"             TEXT NOT NULL,

  -- One confirmation can move several rows (Restore workbook defaults moves all
  -- of them). The batch groups them so the log can show the act, not just its
  -- individual effects.
  "batchId"        TEXT NOT NULL,
  "kind"           "FormulaRevisionKind" NOT NULL,
  "action"         "FormulaRevisionAction" NOT NULL,

  -- Part number for FRAME/HARDWARE, setting key for SETTING. One column rather
  -- than two nullable ones: it is the row's identity in either case.
  "target"         TEXT NOT NULL,
  -- Human-readable name at the time of the change, so a log entry still reads
  -- correctly after a part is renamed or removed from the workbook.
  "targetName"     TEXT,

  -- Complete rule (or {key,value}) before and after. NULL "before" means the row
  -- did not exist; NULL "after" means it was reset back to the workbook default.
  "before"         JSONB,
  "after"          JSONB,
  -- One-line description of what moved, composed at write time. Kept so the log
  -- and the Excel export never have to re-derive wording from two JSON blobs.
  "summary"        TEXT NOT NULL,

  -- The typed confirmation, recorded verbatim. Evidence that the gate was met
  -- rather than a boolean asserting it was.
  "confirmedWord"  TEXT,
  -- Orders judged impacted AT CONFIRMATION TIME: [{id, number, customer}].
  -- Snapshotted rather than recomputed, because which orders were open then is
  -- the fact worth keeping.
  "impactedOrders" JSONB,
  "impactedCount"  INTEGER NOT NULL DEFAULT 0,

  "notifiedAt"     TIMESTAMP(3),
  "notifyError"    TEXT,

  -- Undo bookkeeping. A revision is undone at most once; the revision that did
  -- the undoing points back at this one.
  "undoneAt"       TIMESTAMP(3),
  "undoneById"     TEXT,
  "undoesId"       TEXT,

  "actorId"        TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FormulaRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FormulaRevision_kind_createdAt_idx" ON "FormulaRevision"("kind", "createdAt");
CREATE INDEX "FormulaRevision_batchId_idx" ON "FormulaRevision"("batchId");
CREATE INDEX "FormulaRevision_target_idx" ON "FormulaRevision"("target");
CREATE INDEX "FormulaRevision_actorId_idx" ON "FormulaRevision"("actorId");
CREATE UNIQUE INDEX "FormulaRevision_undoesId_key" ON "FormulaRevision"("undoesId");

ALTER TABLE "FormulaRevision"
  ADD CONSTRAINT "FormulaRevision_undoesId_fkey"
  FOREIGN KEY ("undoesId") REFERENCES "FormulaRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------- 2. Manufacturing release ----------------

ALTER TABLE "AcceptedOrder"
  ADD COLUMN "manufacturingReleasedAt"   TIMESTAMP(3),
  ADD COLUMN "manufacturingReleasedById" TEXT,
  -- A deliberate decision that this job does not need a QuickBooks invoice
  -- before it goes to the shop. Reason is required by the route, so the column
  -- is only NULL while no waiver exists.
  ADD COLUMN "qboInvoiceWaivedAt"        TIMESTAMP(3),
  ADD COLUMN "qboInvoiceWaivedById"      TEXT,
  ADD COLUMN "qboInvoiceWaivedReason"    TEXT;

CREATE INDEX "AcceptedOrder_manufacturingReleasedAt_idx"
  ON "AcceptedOrder"("manufacturingReleasedAt");

-- ---------------- 3. BOM quantity override ----------------

ALTER TABLE "ProcurementLine"
  -- What the formula produced. Written when a line is first created from the
  -- accepted proposal; stays NULL on lines that were added by hand, which have
  -- no formula figure to differ from.
  ADD COLUMN "quantityOriginal"   INTEGER,
  ADD COLUMN "quantityEditedById" TEXT,
  ADD COLUMN "quantityEditedAt"   TIMESTAMP(3);

-- Backfill: for every existing line, the current quantity IS the formula figure,
-- because nothing has been able to edit it until now. Without this, every
-- historic line would badge as "edited" the moment someone touches one.
UPDATE "ProcurementLine" SET "quantityOriginal" = "quantity" WHERE "quantityOriginal" IS NULL;

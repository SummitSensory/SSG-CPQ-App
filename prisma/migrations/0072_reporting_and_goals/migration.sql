-- 0072_reporting_and_goals
--
-- Saved report definitions (with an optional email schedule) and sales goals.
--
-- Two new tables, three new enums, one foreign key. Nothing existing is altered, so
-- this cannot affect a proposal, an order, a document or an integration.
--
-- Every statement is guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- ------------------------------------------------------------------------ enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportCadence') THEN
    CREATE TYPE "ReportCadence" AS ENUM ('NONE', 'WEEKLY', 'MONTHLY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GoalMetric') THEN
    CREATE TYPE "GoalMetric" AS ENUM ('REVENUE', 'DEAL_COUNT', 'PRODUCT_UNITS', 'SAVED_REPORT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GoalPeriod') THEN
    CREATE TYPE "GoalPeriod" AS ENUM ('MONTH', 'QUARTER', 'YEAR');
  END IF;
END $$;

-- ----------------------------------------------------------------- SavedReport
-- `definition` is the same JSON the report builder posts to /insights/query, stored
-- as written rather than normalised into columns: the shape of a report definition
-- will change, and a JSON column changes with it without another migration.
CREATE TABLE IF NOT EXISTS "SavedReport" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "description"   TEXT,
  "definition"    JSONB NOT NULL,
  "shared"        BOOLEAN NOT NULL DEFAULT true,
  "cadence"       "ReportCadence" NOT NULL DEFAULT 'NONE',
  "scheduleDay"   INTEGER,
  "recipients"    TEXT,
  "sendAsId"      TEXT,
  "lastSentAt"    TIMESTAMP(3),
  "lastSendError" TEXT,
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SavedReport_cadence_idx" ON "SavedReport"("cadence");
CREATE INDEX IF NOT EXISTS "SavedReport_createdById_idx" ON "SavedReport"("createdById");

-- ------------------------------------------------------------------- SalesGoal
-- One row per period instance: "October revenue" and "November revenue" are two
-- goals. A target that changes month to month is the normal case, and a single
-- recurring row would either lose the history or need a second table to keep it.
CREATE TABLE IF NOT EXISTS "SalesGoal" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "metric"        "GoalMetric" NOT NULL,
  "period"        "GoalPeriod" NOT NULL,
  "periodStart"   TIMESTAMP(3) NOT NULL,
  "targetMinor"   BIGINT NOT NULL DEFAULT 0,
  "targetCount"   INTEGER,
  "ownerId"       TEXT,
  "skuMatch"      TEXT,
  "savedReportId" TEXT,
  "active"        BOOLEAN NOT NULL DEFAULT true,
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesGoal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SalesGoal_active_idx" ON "SalesGoal"("active");
CREATE INDEX IF NOT EXISTS "SalesGoal_ownerId_idx" ON "SalesGoal"("ownerId");
CREATE INDEX IF NOT EXISTS "SalesGoal_periodStart_idx" ON "SalesGoal"("periodStart");

-- ----------------------------------------------------------------- foreign key
-- SET NULL rather than CASCADE: deleting a report must not delete the record that a
-- target was set. The goal then reports no figure, which is visible on the screen.
--
-- ownerId and createdById are deliberately NOT foreign keys to "User", matching
-- CustomerNote and VendorPartNumber: a deactivated user must not take a target with
-- them, and the name is resolved at read time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SalesGoal_savedReportId_fkey'
  ) THEN
    ALTER TABLE "SalesGoal"
      ADD CONSTRAINT "SalesGoal_savedReportId_fkey" FOREIGN KEY ("savedReportId")
      REFERENCES "SavedReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

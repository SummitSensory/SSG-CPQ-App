-- Editable coefficients behind the H-1000 fastener quantities. Empty by design:
-- src/proposals/hardwareRules.ts holds the v73 workbook defaults, and a row here
-- overrides that default for one part. "Restore workbook defaults" in
-- Administration → Hardware quantity formulas clears/rewrites these rows.

CREATE TABLE "HardwareRule" (
  "id"          TEXT NOT NULL,
  "part"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "terms"       JSONB NOT NULL,
  "constant"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "factor"      DOUBLE PRECISION NOT NULL DEFAULT 1,
  "roundMode"   TEXT NOT NULL DEFAULT 'NONE',
  "roundStep"   DOUBLE PRECISION NOT NULL DEFAULT 1,
  "mode"        TEXT NOT NULL DEFAULT 'SUM',
  "minZero"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "note"        TEXT,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HardwareRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HardwareRule_part_key" ON "HardwareRule" ("part");
CREATE INDEX "HardwareRule_sortOrder_idx" ON "HardwareRule" ("sortOrder");

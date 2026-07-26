-- Formula rules cover two sets now (frame quantities and hardware fasteners), so
-- HardwareRule gains a kind discriminator, term/rule conditions and a group label.
-- FormulaSetting holds the business scalars (deposit %, proposal validity, leg spans).

ALTER TABLE "HardwareRule" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'HARDWARE';
ALTER TABLE "HardwareRule" ADD COLUMN "when" JSONB;
ALTER TABLE "HardwareRule" ADD COLUMN "group" TEXT;

DROP INDEX IF EXISTS "HardwareRule_part_key";
CREATE UNIQUE INDEX "HardwareRule_kind_part_key" ON "HardwareRule" ("kind", "part");

CREATE TABLE "FormulaSetting" (
  "key"         TEXT NOT NULL,
  "value"       DOUBLE PRECISION NOT NULL,
  "updatedById" TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FormulaSetting_pkey" PRIMARY KEY ("key")
);

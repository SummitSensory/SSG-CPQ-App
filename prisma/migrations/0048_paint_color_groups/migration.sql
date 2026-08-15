-- Paint colour groups: which set of parts a customer picks one colour for.
--
-- The grouping belongs to the PART, so it is maintained once and read by every
-- Bill of Materials. "sku" is not a foreign key to Sku for the same reason
-- VendorPartNumber."ourPart" is not: BOM lines can carry generated part numbers
-- that have no catalog row.

CREATE TABLE "PaintColorGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaintColorGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaintColorGroup_name_key" ON "PaintColorGroup"("name");

CREATE TABLE "PaintColorGroupSku" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaintColorGroupSku_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaintColorGroupSku_sku_key" ON "PaintColorGroupSku"("sku");
CREATE INDEX "PaintColorGroupSku_groupId_idx" ON "PaintColorGroupSku"("groupId");

ALTER TABLE "PaintColorGroupSku"
    ADD CONSTRAINT "PaintColorGroupSku_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "PaintColorGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the five groups the chart is built on. Renameable afterwards.
INSERT INTO "PaintColorGroup" ("id", "name", "sortOrder", "updatedAt") VALUES
    ('pcg_seed_a', 'A', 10, CURRENT_TIMESTAMP),
    ('pcg_seed_b', 'B', 20, CURRENT_TIMESTAMP),
    ('pcg_seed_c', 'C', 30, CURRENT_TIMESTAMP),
    ('pcg_seed_d', 'D', 40, CURRENT_TIMESTAMP),
    ('pcg_seed_e', 'E', 50, CURRENT_TIMESTAMP);

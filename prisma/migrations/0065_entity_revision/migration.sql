-- Before/after revision history.
--
-- AuditLog answers "who touched this, and when". It stores the fields that were SENT,
-- so it cannot answer "what was it before" — which is the question actually asked when
-- a cost looks wrong or a bundle lost a part. The formula editor already solved this
-- with its own revision table holding complete snapshots either side of a change; this
-- is the same idea, generalised, for catalog pricing and bundle components.
--
-- Additive and append-only. Nothing reads it to compute anything; it exists to be read
-- by a person.
CREATE TABLE "EntityRevision" (
  "id"        TEXT NOT NULL,
  -- 'Product' | 'Sku' | 'ProductBundle' — the thing that changed.
  "entity"    TEXT NOT NULL,
  "entityId"  TEXT NOT NULL,
  -- A human label for the row: the SKU or the product name as it read AT THE TIME, so
  -- the history stays readable after a rename.
  "label"     TEXT,
  "action"    TEXT NOT NULL,
  "actorId"   TEXT NOT NULL,
  -- Complete snapshots, not diffs. A diff stops being readable the moment the shape
  -- of the record changes; a snapshot does not.
  "before"    JSONB,
  "after"     JSONB,
  -- The field names that actually differ, computed once at write time so the list
  -- view does not have to diff every row it renders.
  "changed"   JSONB,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntityRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EntityRevision_entity_entityId_createdAt_idx"
  ON "EntityRevision" ("entity", "entityId", "createdAt" DESC);
CREATE INDEX "EntityRevision_createdAt_idx" ON "EntityRevision" ("createdAt" DESC);
CREATE INDEX "EntityRevision_actorId_idx" ON "EntityRevision" ("actorId");

-- Rollback
-- DROP TABLE "EntityRevision";

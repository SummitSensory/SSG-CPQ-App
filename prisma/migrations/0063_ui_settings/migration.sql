-- Small string-keyed store for UI choices an administrator makes.
--
-- FormulaSetting already exists for business scalars, but its value column is a
-- Float: it cannot hold "#fdecea". Rather than widen a table the pricing engine
-- reads on every proposal, this is its own two-column table.
--
-- Additive: one table, no enums, no alters. Safe to apply ahead of the code.

CREATE TABLE IF NOT EXISTS "UiSetting" (
  "key"         TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT,

  CONSTRAINT "UiSetting_pkey" PRIMARY KEY ("key")
);

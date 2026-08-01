-- Sku: fixed per-part freight defaults.
--
-- These two columns exist in schema.prisma but were never captured in a
-- migration, so the production database is missing them and any read of the
-- Sku model fails with P2022 (see catalogItems PATCH /catalog/items/:part).
--
-- freightMinor: fixed freight charge applied to this part's proposal line
--   automatically. NULL = no default; 0 = an explicit "no freight". A rep's
--   entry always wins.
-- freightLabel: wording for that freight row. Defaults to "Freight" when blank.
--
-- Both nullable with no default, so this is additive and safe to apply to a
-- live database: existing rows get NULL, and older application builds that
-- don't select these columns are unaffected.

ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "freightMinor" INTEGER;
ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "freightLabel" TEXT;

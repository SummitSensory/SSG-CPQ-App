-- Packaging bag numbers.
--
-- Two additive columns behind the packaging-bag feature:
--
--   Sku.packagingBag             The bag a part ships in, e.g. "Bag 7". Set on
--                                about thirty hardware items so the shop knows
--                                which bag to open. NULL = not bagged.
--   BomVendorSection.showPackagingBag
--                                Whether this vendor's sheet prints the bag
--                                column. Opt-in, the same way showPowderColor is.
--
-- Both are nullable or defaulted, so this is safe on a live database: existing
-- rows get NULL / false, and older application builds that don't select these
-- columns are unaffected.
--
-- Bag values themselves are NOT loaded here — run `pnpm db:bags` after applying,
-- which reads prisma/packaging-bags.csv and skips parts not in the catalog.

ALTER TABLE "Sku" ADD COLUMN IF NOT EXISTS "packagingBag" TEXT;
ALTER TABLE "BomVendorSection" ADD COLUMN IF NOT EXISTS "showPackagingBag" BOOLEAN NOT NULL DEFAULT false;

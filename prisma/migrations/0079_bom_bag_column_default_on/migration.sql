-- 0079_bom_bag_column_default_on
--
-- New Bill of Materials vendor sections now show the packaging-bag column by
-- default (a rep can still opt a section out), matching powder colour's
-- opt-out-instead-of-opt-in-by-default treatment. Does not change any
-- already-created section's stored value — only what a brand new row defaults
-- to. `SET DEFAULT` is inherently safe to re-run: it just re-asserts the same
-- default each time, so no explicit guard is needed here.

ALTER TABLE "BomVendorSection" ALTER COLUMN "showPackagingBag" SET DEFAULT true;

-- 0117_vendor_color_uses_brand
--
-- Manufacturer.bomColorUsesBrand: whether a vendor's BOM colours are a powder-coat
-- brand plus a code (the default, every existing vendor) or just a colour from the
-- vendor's own chart. Resilite's vinyl colours carry no powder brand, so the BOM's
-- "Colour by group" row stops demanding one for them.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "bomColorUsesBrand" BOOLEAN NOT NULL DEFAULT true;

-- Resilite's colours are its own vinyl chart, not a powder brand. Editable afterwards
-- on the vendor's profile; setting it again on a re-run changes nothing.
UPDATE "Manufacturer" SET "bomColorUsesBrand" = false WHERE lower("name") = 'resilite';

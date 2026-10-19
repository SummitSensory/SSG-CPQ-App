-- 0118_vendor_color_heading
--
-- Manufacturer.bomColorHeading: the colour column's heading on a vendor's Bill of
-- Materials. Blank keeps "Powder color" for every existing vendor. Resilite's mats
-- are vinyl, so its sheet reads "Vinyl color".
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "bomColorHeading" TEXT;

-- Only fills a blank heading, so a re-run never overwrites one edited on the profile.
UPDATE "Manufacturer" SET "bomColorHeading" = 'Vinyl color'
WHERE lower("name") = 'resilite' AND "bomColorHeading" IS NULL;

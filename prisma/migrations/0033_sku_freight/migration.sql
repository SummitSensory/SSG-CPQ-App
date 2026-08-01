-- 0033_sku_packaging_bag
--
-- About thirty hardware items ship inside a numbered packaging bag. The shop
-- needs to know which bag to open; nobody else does. So the bag lives on the
-- SKU (one edit re-labels every sheet the part appears on) and prints on a
-- vendor's Bill of Materials only when that section asks for it.

ALTER TABLE "Sku" ADD COLUMN "packagingBag" TEXT;

-- Opt-in per BOM section, exactly like the powder-colour column. Off by
-- default: on a sheet with no bagged parts the column would be all dashes.
ALTER TABLE "BomVendorSection" ADD COLUMN "showPackagingBag" BOOLEAN NOT NULL DEFAULT false;

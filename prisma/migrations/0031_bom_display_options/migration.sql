-- 0031_bom_display_options
--
-- Two BOM display changes that belong to the vendor, not to the document:
--
--   * showPowderColor — the powder-colour column was printed on every vendor's
--     sheet. Most vendors do not powder coat anything, so it was a column of
--     dashes. It is now opt-in per section.
--   * isHardwareComponent / kitSku — the H-1000 kit is now expanded into its
--     component fasteners when an order is locked, and those lines print as the
--     BOM's trailing Hardware section.

ALTER TABLE "BomVendorSection" ADD COLUMN "showPowderColor" BOOLEAN NOT NULL DEFAULT false;

-- Vendors who were already given a colour keep the column: turning it off under
-- them would silently drop information from a sheet they have seen.
UPDATE "BomVendorSection" s SET "showPowderColor" = true
WHERE EXISTS (
  SELECT 1 FROM "ProcurementLine" l
  WHERE l."orderId" = s."orderId"
    AND COALESCE(NULLIF(btrim(l."vendor"), ''), 'Unassigned vendor') = s."vendor"
    AND (COALESCE(btrim(l."powderColor"), '') <> '' OR COALESCE(btrim(l."powderColorCode"), '') <> '')
);

-- Set on the vendor default so a NEW section for a powder-coating vendor starts
-- with the column already on.
ALTER TABLE "Manufacturer" ADD COLUMN "bomShowPowderColor" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Manufacturer" m SET "bomShowPowderColor" = true
WHERE EXISTS (
  SELECT 1 FROM "ProcurementLine" l
  WHERE l."vendor" = m."name"
    AND (COALESCE(btrim(l."powderColor"), '') <> '' OR COALESCE(btrim(l."powderColorCode"), '') <> '')
);

-- ---------------------------------------------------------------------------
-- Hardware expansion
--
-- The proposal shows one "Hardware Kit" line (H-1000) because that is what the
-- customer buys. The shop cannot build from that — it needs every fastener and
-- its count. `isHardwareComponent` marks the lines produced by expanding the kit
-- so the BOM can group them into their own trailing section, and
-- `kitSku` records which kit a component came from.
-- ---------------------------------------------------------------------------

ALTER TABLE "ProcurementLine" ADD COLUMN "isHardwareComponent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProcurementLine" ADD COLUMN "kitSku" TEXT;

-- Orders locked BEFORE this migration keep their single H-1000 line: the component
-- breakdown is written onto the proposal at build time, and those proposals were
-- saved without it. Nothing is lost and no total changes — but to itemise hardware
-- on an existing order, reopen its Adventure proposal, save it, and re-lock.

-- Retire the legacy Adventure floor-mat SKUs.
--
-- Floor padding is now sized and priced by formula (src/proposals/matPricing.ts)
-- under the current part-number format R-SSG-{LLWW}CLM[-2]. The old hand-entered
-- R-SSA-…CLM rows are stale (several carried prices that no longer agree with the
-- $/sq ft cost list) and must not be pickable by hand.
--
-- Products an accepted order still points at are kept and marked INACTIVE instead
-- of deleted, so signed paperwork stays exactly as priced.

-- Flat SKU records the proposal engine multiplies against.
DELETE FROM "Sku" WHERE "part" ~* '^R-SSA-[0-9]+CLM';

-- Retire the catalog products.
UPDATE "Product"
SET "status" = 'INACTIVE', "updatedAt" = NOW()
WHERE "sku" ~* '^R-SSA-[0-9]+CLM';

-- Remove the ones no order references (tiers, costs, sourcing and notes cascade).
DELETE FROM "Product" p
WHERE p."sku" ~* '^R-SSA-[0-9]+CLM'
  AND NOT EXISTS (SELECT 1 FROM "ProcurementLine" pl WHERE pl."productId" = p."id");

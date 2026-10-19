-- 0119_soar_xl_frame_weight
--
-- The Soar XL frames (K-4001 S1-XL, K-4006 S2-XL, K-4007 S3-XL) were catalogued at
-- 0 lb, so a Soar XL proposal and its freight request understated the shipment by
-- the whole frame. Each frame weighs 500 lb (Bryan, 2026-10-19).
--
-- Only a weight still at 0 is filled, so a weight already entered in the Catalog is
-- never overwritten, and a re-run changes nothing. Data only, no schema change.

UPDATE "Sku" SET "weightLbs" = 500
WHERE "part" IN ('K-4001', 'K-4006', 'K-4007') AND "weightLbs" = 0;

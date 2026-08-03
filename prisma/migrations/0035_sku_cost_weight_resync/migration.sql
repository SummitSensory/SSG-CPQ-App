-- Migration 0018 backfilled Sku.unitCostMinor / weightLbs from the workbook's dated
-- cost history and Product.weightOz. Everything imported SINCE then arrived the same
-- way and has the same gap: a cost visible in the catalog list (which falls back to
-- the history) but 0 on the flat Sku row the proposal builder quotes from — so the
-- line inserts at cost 0 and 100% margin. The Pediasuit belts are the current case.
--
-- Same statements as 0018, re-run over everything that has appeared since. Still
-- conservative: only rows whose Sku figure is 0 are touched, so a cost typed into
-- the catalog by hand is never overwritten.

UPDATE "Sku" s
SET "unitCostMinor" = sub.cost
FROM (
  SELECT p."sku" AS part, c."unitCost"::bigint AS cost
  FROM "Product" p
  JOIN LATERAL (
    SELECT pc."unitCost"
    FROM "ProductCost" pc
    WHERE pc."productId" = p."id"
    ORDER BY pc."effectiveDate" DESC
    LIMIT 1
  ) c ON TRUE
) sub
WHERE s."part" = sub.part
  AND s."unitCostMinor" = 0
  AND sub.cost > 0;

UPDATE "Sku" s
SET "weightLbs" = ROUND((p."weightOz"::numeric / 16), 3)
FROM "Product" p
WHERE s."part" = p."sku"
  AND s."weightLbs" = 0
  AND p."weightOz" IS NOT NULL
  AND p."weightOz" > 0;

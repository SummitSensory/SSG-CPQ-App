-- The costs and weights from the product workbook were imported into ProductCost
-- (dated cost history, read by pricing/service.ts) and Product.weightOz. The flat
-- Sku record the proposal engine multiplies against had its own empty
-- unitCostMinor/weightLbs columns, so the catalog list and margins showed $0.00.
-- Backfill Sku from those existing values, matching on part number = Product.sku.

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

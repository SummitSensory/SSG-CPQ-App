-- The Summit Flex belts imported with sortOrder 0 on every size except TBD and
-- XX Small, so the picker fell back to insertion order and listed XX Small after
-- Medium. Give the run real numbers, smallest to largest, in the same 10-step
-- spacing the rest of the workbook uses. The TBD placeholder sorts last.

UPDATE "ProductCategory" SET "sortOrder" = 52120 WHERE "slug" = 'flex--flex-belt-xxs';
UPDATE "ProductCategory" SET "sortOrder" = 52130 WHERE "slug" = 'flex--flex-belt-xs';
UPDATE "ProductCategory" SET "sortOrder" = 52140 WHERE "slug" = 'flex--flex-belt-s';
UPDATE "ProductCategory" SET "sortOrder" = 52150 WHERE "slug" = 'flex--flex-belt-m';
UPDATE "ProductCategory" SET "sortOrder" = 52160 WHERE "slug" = 'flex--flex-belt-l';
UPDATE "ProductCategory" SET "sortOrder" = 52170 WHERE "slug" = 'flex--flex-belt-xl';
UPDATE "ProductCategory" SET "sortOrder" = 52180 WHERE "slug" = 'flex--flex-belt-xxl';
UPDATE "ProductCategory" SET "sortOrder" = 52190 WHERE "slug" = 'flex--flex-belt-tbd';

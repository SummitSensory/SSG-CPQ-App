-- 0110_rename_adventure_components_group
--
-- Data only. Renames the "Therapeutic Activity & Adventure Components" proposal
-- section to "Adventure Components".
--
-- The old name was long enough that the printed heading, with its "· OPTIONAL" tag,
-- stepped down to the smallest heading size and no longer matched the other section
-- headings. The Adventure engine now writes the short name. This brings the catalog
-- into line so the builder creates the same heading when a part is picked onto a
-- proposal:
--
--   * The top-level ProductCategory whose name becomes the section heading.
--     The slug is left alone, so nothing that links to the category changes.
--   * Sku.proposalGroup, the fallback heading for a part with no tree position.
--
-- No proposal is touched. Proposals snapshot their lines, and ones already saved
-- keep the old heading. The engine and the builder still accept the old name,
-- so parts keep filing under it.
--
-- Both statements match only the old name, so running this again changes nothing.

UPDATE "ProductCategory"
SET "name" = 'ADVENTURE COMPONENTS'
WHERE "parentId" IS NULL
  AND lower(trim("name")) = 'therapeutic activity & adventure components';

UPDATE "Sku"
SET "proposalGroup" = 'Adventure Components',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE lower(trim("proposalGroup")) = 'therapeutic activity & adventure components';

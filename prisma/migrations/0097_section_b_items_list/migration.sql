-- 0097_section_b_items_list
--
-- Replaces Section B's single admin-default-plus-per-proposal-override clarifying
-- text field (shipped in migration 0096, one day prior) with a proper add/remove/
-- reorder item list, matching Section C's existing architecture exactly -- see
-- src/crossborder/sectionB.ts. Dropped columns carried no real data: no administrator
-- had set a Section B default or per-proposal override yet, so this is a clean
-- replacement, not a data migration.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting"
  DROP COLUMN IF EXISTS "defaultSectionBSubtext",
  DROP COLUMN IF EXISTS "defaultSectionBSubtextSizePt",
  ADD COLUMN IF NOT EXISTS "sectionBTemplate" JSONB;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry"
  DROP COLUMN IF EXISTS "sectionBSubtextOverride",
  DROP COLUMN IF EXISTS "sectionBSubtextSizePtOverride",
  ADD COLUMN IF NOT EXISTS "sectionBItems" JSONB;

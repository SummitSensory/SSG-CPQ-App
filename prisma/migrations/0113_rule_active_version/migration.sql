-- 0113_rule_active_version
--
-- Generated from the difference between prisma/schema.prisma and the database.
-- A rule now has a separate "approved, live" version pointer. Saving a new version of
-- an ACTIVE rule used to put the unapproved definition live at once (and skipped the
-- circular-dependency check, which only ran on activation); now only activation moves
-- the pointer. Every existing rule is backfilled to its currentVersion, so it keeps
-- evaluating exactly the definition it evaluated before this migration.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "Rule" ADD COLUMN IF NOT EXISTS     "activeVersion" INTEGER;

-- Backfill: live version = what the engine read until now. Only fills NULLs, so a
-- re-run never moves a pointer an activation has since set.
UPDATE "Rule" SET "activeVersion" = "currentVersion" WHERE "activeVersion" IS NULL;

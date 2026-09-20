-- 0096_canadian_section_b_subtext_and_gating
--
-- Adds an admin-default-plus-per-proposal-override clarifying text block for Section B
-- (Delivery and Post-Importation Services), sized 7-12pt, using the same **bold**/
-- *italic* markup convention rt() already renders everywhere else in this app. Also
-- adds requireSectionCCompleteBeforeFinal (default true), a new release gate alongside
-- the existing requireCustomsReviewBeforeFinal/requireTaxReviewBeforeFinal toggles,
-- covering the Section A functional description and every row in a Canadian
-- proposal's resolved Section C list — see crossBorderStateFor's new `content:*`
-- blockers. Every new column is nullable with no @default (except the boolean gate,
-- which defaults on to match its siblings), so nothing about an existing proposal or
-- setting changes on deploy.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "CrossBorderSetting"
  ADD COLUMN IF NOT EXISTS "defaultSectionBSubtext" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultSectionBSubtextSizePt" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "requireSectionCCompleteBeforeFinal" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ProposalCustomsEntry"
  ADD COLUMN IF NOT EXISTS "sectionBSubtextOverride" TEXT,
  ADD COLUMN IF NOT EXISTS "sectionBSubtextSizePtOverride" DOUBLE PRECISION;

-- 0089_add_user_dashboard_layout
--
-- Lets a user save their own custom dashboard layout (which widgets show, and in
-- what order) so it follows them to any computer they sign into, instead of only
-- being remembered by the browser they set it up on.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS     "dashboardLayout" JSONB;

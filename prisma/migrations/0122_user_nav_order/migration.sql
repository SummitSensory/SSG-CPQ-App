-- 0122_user_nav_order
--
-- Each user can reorder the left-hand navigation tabs (Bryan, 2026-10-22). The order
-- is a per-user display preference saved to the account, like User.dashboardLayout,
-- so it follows the user between browsers. Null means the default order.
--
-- Guarded so a re-run is harmless: migrate-deploy.mjs runs on every deploy and a
-- half-applied migration must be repairable by running it again.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "navOrder" JSONB;

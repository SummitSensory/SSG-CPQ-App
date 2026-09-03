-- 0080_user_tips_enabled
--
-- Adds the per-user on/off switch for the Tips & Tricks helper (see PATCH
-- /auth/me and public/tips-and-tricks.js). Defaults to true so the feature is
-- visible without a migration-time backfill, and `ADD COLUMN IF NOT EXISTS`
-- makes this safe to re-run if a deploy is interrupted between statements.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tipsEnabled" BOOLEAN NOT NULL DEFAULT true;

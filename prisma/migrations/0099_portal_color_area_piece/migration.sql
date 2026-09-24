-- 0099_portal_color_area_piece
--
-- Generated from the difference between prisma/schema.prisma and the database.
-- Portal colour areas can now say WHICH PIECE of a multi-piece part they colour
-- (a Palisades or 90° Climb & Slide mat system is one part number with a vinyl
-- colour per piece). Nullable: every existing mapping keeps meaning "the whole part".
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "PortalColorAreaMapping" ADD COLUMN IF NOT EXISTS     "piece" INTEGER;

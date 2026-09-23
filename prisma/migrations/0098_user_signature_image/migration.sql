-- 0098_user_signature_image
--
-- User.signatureImage (the profile signature a user saves under My Profile, used on
-- documents they send) was added to schema.prisma without a migration. Production
-- has the column; any database built from the migrations alone — CI's throwaway
-- database, a new environment — did not, so saving a signature failed there.
--
-- Guarded, so it is a no-op wherever the column already exists.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureImage" TEXT;

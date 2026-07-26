-- Preparer details shown in the "Proposal Prepared By" block on proposals.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;

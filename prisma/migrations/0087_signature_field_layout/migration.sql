-- 0087_signature_field_layout
--
-- One singleton row holding manual pixel nudges for the six signature/date boxes on
-- the Acceptance and Acknowledgment pages, so a rep can drag a box in the admin editor
-- to the exact spot it should print at and have every proposal use it from then on,
-- instead of re-describing the position by hand each time.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateTable
CREATE TABLE IF NOT EXISTS "SignatureFieldLayout" (
    "key" TEXT NOT NULL DEFAULT 'default',
    "offsets" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "SignatureFieldLayout_pkey" PRIMARY KEY ("key")
);

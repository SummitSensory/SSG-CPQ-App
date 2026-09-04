-- 0085_add_esign_email_templates
--
-- Adds the ~10 "please sign this" email templates (EsignEmailTemplate, auto-picked
-- by product line like the existing signing document templates) and the columns
-- that record which one an envelope used and who actually sent it.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "emailSentFromUserId" TEXT;
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "emailTemplateId" TEXT;
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "emailTemplateKey" TEXT;

-- AlterTable
ALTER TABLE "EsignSigner" ADD COLUMN IF NOT EXISTS "emailedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EsignEmailTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "productLineIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsignEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EsignEmailTemplate_key_key" ON "EsignEmailTemplate"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EsignEmailTemplate_active_idx" ON "EsignEmailTemplate"("active");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EsignEnvelope_emailTemplateId_fkey'
  ) THEN
    ALTER TABLE "EsignEnvelope" ADD CONSTRAINT "EsignEnvelope_emailTemplateId_fkey"
      FOREIGN KEY ("emailTemplateId") REFERENCES "EsignEmailTemplate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

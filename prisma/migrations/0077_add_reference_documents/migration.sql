-- 0077_add_reference_documents
--
-- Adds the uploaded-file reference-document library (a W9, a certificate of
-- insurance) that can be attached to a proposal, plus the column recording which
-- of them were merged into a given e-sign envelope's packet.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS     "referenceDocuments" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ReferenceDocument" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ReferenceDocument_key_key" ON "ReferenceDocument"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReferenceDocument_active_sortOrder_idx" ON "ReferenceDocument"("active", "sortOrder");

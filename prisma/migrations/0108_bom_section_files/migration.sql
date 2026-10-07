-- 0108_bom_section_files
--
-- Files uploaded against one vendor's Bill of Materials (drawings, spec sheets),
-- which the sender can tick to attach when emailing that BOM to the vendor, plus
-- a record on each BOM email of which files went out with it.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "BomSend" ADD COLUMN IF NOT EXISTS     "attachedFiles" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomSectionFile" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BomSectionFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomSectionFile_sectionId_idx" ON "BomSectionFile"("sectionId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BomSectionFile_sectionId_fkey') THEN
    ALTER TABLE "BomSectionFile" ADD CONSTRAINT "BomSectionFile_sectionId_fkey" FOREIGN KEY ("sectionId")
      REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

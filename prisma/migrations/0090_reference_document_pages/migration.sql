-- 0090_reference_document_pages
--
-- Cache slots for a reference document's rasterized pages (one PNG per PDF page),
-- pointing at the same blob store as the document's own file — see the field
-- comment on ReferenceDocument.pagesUrl in schema.prisma. Nullable and populated
-- lazily by the first proposal preview that needs them.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "ReferenceDocument" ADD COLUMN IF NOT EXISTS "pagesPathname" TEXT;
ALTER TABLE "ReferenceDocument" ADD COLUMN IF NOT EXISTS "pagesUrl" TEXT;

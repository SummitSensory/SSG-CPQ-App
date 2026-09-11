-- 0090_add_reference_document_page_images
--
-- Caches a reference document's PDF pages, rendered once as images, so the proposal
-- preview overlay and the browser's own Print/Save-PDF can show a W9 or certificate of
-- insurance as real pages instead of rasterizing it again on every proposal preview.
-- See ReferenceDocument.pageImages in schema.prisma and src/render/pdfRaster.ts.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.
--
-- Hand-edited from what `pnpm db:new --guard` generated: the shared dev database this
-- diffed against also carries "pagesPathname"/"pagesUrl" columns from a separate,
-- concurrently-in-progress change to this same table that is not yet in this branch's
-- schema.prisma or migration history. This migration only adds this branch's own
-- column; it deliberately does not drop those columns, since doing so here would
-- destroy state a different in-flight change on the shared database depends on. See
-- this PR's description for the coordination note this leaves for whoever merges next.

-- AlterTable
ALTER TABLE "ReferenceDocument" ADD COLUMN IF NOT EXISTS "pageImages" JSONB;

-- 0084_esign_envelope_renderings
--
-- Records which ProposalRendering ids were bound into a signature request, in
-- order sent — the audit answer to "which renderings did they actually sign
-- alongside", the same as the existing attachments/referenceDocuments columns.

-- AlterTable
ALTER TABLE "EsignEnvelope" ADD COLUMN IF NOT EXISTS "renderings" JSONB;

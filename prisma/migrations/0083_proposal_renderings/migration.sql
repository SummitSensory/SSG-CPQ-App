-- 0083_proposal_renderings
--
-- New table for design renderings (CAD exports, photorealistic renders, scanned
-- drawings) attached to a proposal — uploaded client-to-blob directly rather than
-- through the server, since these routinely exceed the ~4.5 MB Vercel function
-- body limit every other upload path in this repo is bounded by. See
-- src/lib/renderingStore.ts.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProposalRendering" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalRendering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalRendering_proposalId_sortOrder_idx" ON "ProposalRendering"("proposalId", "sortOrder");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProposalRendering_proposalId_fkey') THEN
    ALTER TABLE "ProposalRendering" ADD CONSTRAINT "ProposalRendering_proposalId_fkey"
      FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

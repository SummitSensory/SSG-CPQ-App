-- 0075_legal_documents
--
-- Makes the two proposal legal documents editable, and freezes the text onto a proposal
-- when it is released.
--
-- No data migration. LegalDocument starts empty on purpose: with no row, the renderer and
-- src/legal/defaults.ts print the text this release was built with, so the printed output
-- is unchanged until an administrator publishes an edit. The first publish creates the row.
--
-- ProposalVersion.legalSnapshotId is nullable and stays NULL for every version released
-- before this migration. That is the honest record — those releases were not pinned, and
-- backfilling today's wording onto them would assert something untrue about what a
-- customer was shown.

CREATE TABLE "LegalDocument" (
    -- The key, not a generated id. The renderer asks for RELEASE and TERMS by name, and
    -- the title is editable, so nothing may key off what the document currently calls
    -- itself.
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    -- An unpublished edit. NULL means the published copy is the only copy. A lawyer's
    -- half-finished redline must not print on tomorrow's proposal.
    "draft" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "draftSavedAt" TIMESTAMP(3),
    "draftSavedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("key")
);

-- Every published revision, immutable, so a snapshot can be explained after the fact and
-- an edit can be rolled back to a known wording rather than retyped.
CREATE TABLE "LegalDocumentRevision" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocumentRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalDocumentRevision_key_version_key"
    ON "LegalDocumentRevision"("key", "version");

-- The legal text exactly as printed when a proposal was released.
--
-- Content-addressed: releasing fifty proposals under one wording writes one row and fifty
-- references, and "which proposals went out under this wording" is answerable by grouping
-- on the id.
CREATE TABLE "LegalSnapshot" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "documents" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalSnapshot_hash_key" ON "LegalSnapshot"("hash");

ALTER TABLE "ProposalVersion" ADD COLUMN "legalSnapshotId" TEXT;

CREATE INDEX "ProposalVersion_legalSnapshotId_idx"
    ON "ProposalVersion"("legalSnapshotId");

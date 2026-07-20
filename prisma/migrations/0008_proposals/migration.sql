CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT','INTERNAL_REVIEW','RELEASED','ACCEPTED','REJECTED','EXPIRED');

CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Proposal_number_key" ON "Proposal"("number");
CREATE INDEX "Proposal_organizationId_idx" ON "Proposal"("organizationId");

CREATE TABLE "ProposalVersion" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "sections" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "priceSnapshotId" TEXT,
    "ruleSnapshotId" TEXT,
    "expirationDate" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProposalVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProposalVersion_proposalId_version_key" ON "ProposalVersion"("proposalId", "version");
CREATE INDEX "ProposalVersion_proposalId_idx" ON "ProposalVersion"("proposalId");
CREATE INDEX "ProposalVersion_status_idx" ON "ProposalVersion"("status");
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProposalStatusEvent" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fromStatus" "ProposalStatus",
    "toStatus" "ProposalStatus" NOT NULL,
    "note" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProposalStatusEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProposalStatusEvent_versionId_idx" ON "ProposalStatusEvent"("versionId");
ALTER TABLE "ProposalStatusEvent" ADD CONSTRAINT "ProposalStatusEvent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ProposalVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

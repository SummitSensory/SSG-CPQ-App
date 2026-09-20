-- 0092_add_media_partnership_program
--
-- Adds the Customer Project Media Rebate feature: a global, admin-configurable
-- "Media Partnership Program" settings row, a content-addressed snapshot table for
-- freezing its terms onto a proposal version at release, and the pointer column on
-- ProposalVersion. All additive and backward-compatible — no existing column, table,
-- or row is touched.
--
-- NOTE: `pnpm db:new --guard` also generated DROP COLUMN/DROP TYPE statements for
-- CrossBorderSetting/ProposalCustomsEntry GST-HST/tariff fields and GstHstTreatment.
-- Those are unrelated to this feature: the connected database has schema from the
-- not-yet-merged claude/canadian-proposal-v1-1 branch that main's prisma/schema.prisma
-- does not have yet. Deliberately excluded here — applying them would destroy another
-- in-flight feature's columns. This is pre-existing drift between main and that
-- database, not something this migration should touch or fix.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- AlterTable
ALTER TABLE "ProposalVersion" ADD COLUMN IF NOT EXISTS "mediaRebateSnapshotId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "MediaPartnershipProgram" (
    "key" TEXT NOT NULL DEFAULT 'default',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "customerFacingName" TEXT NOT NULL DEFAULT 'Customer Project Media Rebate',
    "internalName" TEXT NOT NULL DEFAULT 'Media Partnership Program',
    "rebateAmountMinor" INTEGER NOT NULL DEFAULT 25000,
    "content" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "MediaPartnershipProgram_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MediaRebateSnapshot" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaRebateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MediaRebateSnapshot_hash_key" ON "MediaRebateSnapshot"("hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalVersion_mediaRebateSnapshotId_idx" ON "ProposalVersion"("mediaRebateSnapshotId");

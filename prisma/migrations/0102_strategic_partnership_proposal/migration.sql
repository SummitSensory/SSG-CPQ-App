-- 0102_strategic_partnership_proposal
--
-- Strategic Partnership Proposals: a per-customer record of multi-site partnership
-- terms (discount, project value, PM hours, rollout plan), the economics the backend
-- calculates from them (including the first-class 3-Year Equipment Savings), and the
-- Canva document generated from both. Plus the org-wide settings row (Canva brand
-- template id and the editable proposal copy) and the single encrypted Canva
-- connection. Purely additive: three new tables and one new enum; nothing existing
-- changes.
--
-- Numbered 0102 because 0101 is taken by an open change (mats_freight_tax_sync).
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StrategicPartnershipStatus') THEN
  CREATE TYPE "StrategicPartnershipStatus" AS ENUM ('DRAFT', 'READY_TO_GENERATE', 'CALCULATING', 'GENERATING_CANVA', 'READY_FOR_REVIEW', 'APPROVED', 'SENT', 'ERROR');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "StrategicPartnershipProposal" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "status" "StrategicPartnershipStatus" NOT NULL DEFAULT 'DRAFT',
    "customerShortName" TEXT NOT NULL,
    "customerFullName" TEXT NOT NULL,
    "executiveName" TEXT NOT NULL,
    "executiveTitle" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "partnerDiscountBps" INTEGER,
    "standardProjectValueMinor" BIGINT,
    "pmHoursReturnedPerCenterHundredths" INTEGER,
    "pmHourValueMinor" BIGINT,
    "contributionMarginPerHourMinor" BIGINT,
    "year1PlannedCenters" INTEGER,
    "year2PlannedCenters" INTEGER,
    "year3PlannedCenters" INTEGER,
    "year4PlannedCenters" INTEGER,
    "year5PlannedCenters" INTEGER,
    "customerLogo" JSONB,
    "projectImages" JSONB NOT NULL DEFAULT '[]',
    "partnerProjectValueMinor" BIGINT,
    "savingsPerCenterMinor" BIGINT,
    "threeYearEquipmentSavingsMinor" BIGINT,
    "fiveYearEquipmentSavingsMinor" BIGINT,
    "pmCapacityValuePerCenterMinor" BIGINT,
    "threeYearPmCapacityValueMinor" BIGINT,
    "fiveYearPmCapacityValueMinor" BIGINT,
    "threeYearCombinedValueMinor" BIGINT,
    "fiveYearCombinedValueMinor" BIGINT,
    "threeYearCumulativeCenters" INTEGER,
    "fiveYearCumulativeCenters" INTEGER,
    "calculatedAt" TIMESTAMP(3),
    "calculationVersion" INTEGER,
    "automationRunId" TEXT,
    "generation" JSONB,
    "generatedSnapshot" JSONB,
    "errorMessage" TEXT,
    "canvaDesignId" TEXT,
    "canvaDesignUrl" TEXT,
    "canvaViewUrl" TEXT,
    "pdfUrl" TEXT,
    "pdfPathname" TEXT,
    "generatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategicPartnershipProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StrategicPartnershipSettings" (
    "key" TEXT NOT NULL DEFAULT 'default',
    "brandTemplateId" TEXT,
    "content" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategicPartnershipSettings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CanvaConnection" (
    "key" TEXT NOT NULL DEFAULT 'default',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "pendingState" TEXT,
    "pendingVerifier" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanvaConnection_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StrategicPartnershipProposal_number_key" ON "StrategicPartnershipProposal"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StrategicPartnershipProposal_organizationId_idx" ON "StrategicPartnershipProposal"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StrategicPartnershipProposal_status_idx" ON "StrategicPartnershipProposal"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StrategicPartnershipProposal_opportunityId_idx" ON "StrategicPartnershipProposal"("opportunityId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StrategicPartnershipProposal_organizationId_fkey') THEN
    ALTER TABLE "StrategicPartnershipProposal" ADD CONSTRAINT "StrategicPartnershipProposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

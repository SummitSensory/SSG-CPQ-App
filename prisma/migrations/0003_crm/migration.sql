-- Extend AuditLog with entity targeting
ALTER TABLE "AuditLog" ADD COLUMN "entity" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "entityId" TEXT;
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- Enums
CREATE TYPE "CustomerType" AS ENUM ('HEALTHCARE_SYSTEM','HOSPITAL','PRIVATE_PRACTICE','SCHOOL','UNIVERSITY','GOVERNMENT','NONPROFIT','OTHER');
CREATE TYPE "OpportunityStage" AS ENUM ('PROSPECT','QUALIFICATION','NEEDS_ANALYSIS','PROPOSAL','NEGOTIATION','CLOSED_WON','CLOSED_LOST');
CREATE TYPE "FundingStatus" AS ENUM ('UNFUNDED','BUDGETED','GRANT_PENDING','GRANT_AWARDED','APPROVED','SELF_FUNDED');
CREATE TYPE "TherapyDiscipline" AS ENUM ('PHYSICAL','OCCUPATIONAL','SPEECH','ABA','SENSORY_INTEGRATION','RECREATIONAL','AQUATIC','PSYCHOLOGICAL');
CREATE TYPE "PatientPopulation" AS ENUM ('PEDIATRIC','ADOLESCENT','ADULT','GERIATRIC','SPECIAL_NEEDS','VETERANS');
CREATE TYPE "AddressType" AS ENUM ('BILLING','SHIPPING');
CREATE TYPE "FloorType" AS ENUM ('CARPET','VINYL','TILE','CONCRETE','HARDWOOD','RUBBER','OTHER');
CREATE TYPE "WallConstruction" AS ENUM ('DRYWALL','CONCRETE_BLOCK','BRICK','PLASTER','GLASS','MODULAR','OTHER');
CREATE TYPE "AttachmentCategory" AS ENUM ('PHOTOGRAPH','FLOOR_PLAN','MEASUREMENT_DOC','OTHER');

-- Organization
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL DEFAULT 'OTHER',
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxExemptId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_normalizedName_key" ON "Organization"("normalizedName");
CREATE INDEX "Organization_customerType_idx" ON "Organization"("customerType");

-- Contact
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");
CREATE INDEX "Contact_email_idx" ON "Contact"("email");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Address
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "AddressType" NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Address_organizationId_idx" ON "Address"("organizationId");
ALTER TABLE "Address" ADD CONSTRAINT "Address_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Facility
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Facility_organizationId_idx" ON "Facility"("organizationId");
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Room
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lengthIn" INTEGER,
    "widthIn" INTEGER,
    "ceilingHeightIn" INTEGER,
    "doorWidthIn" INTEGER,
    "doorHeightIn" INTEGER,
    "floorType" "FloorType",
    "wallConstruction" "WallConstruction",
    "hasLoadingDock" BOOLEAN NOT NULL DEFAULT false,
    "liftgateRequired" BOOLEAN NOT NULL DEFAULT false,
    "deliveryRestrictions" TEXT,
    "installationRestrictions" TEXT,
    "notes" TEXT,
    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Room_facilityId_idx" ON "Room"("facilityId");
ALTER TABLE "Room" ADD CONSTRAINT "Room_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Opportunity
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'PROSPECT',
    "fundingStatus" "FundingStatus" NOT NULL DEFAULT 'UNFUNDED',
    "therapyDisciplines" "TherapyDiscipline"[],
    "patientPopulations" "PatientPopulation"[],
    "budgetAmountMinor" BIGINT,
    "budgetCurrency" TEXT,
    "desiredTimeline" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Opportunity_organizationId_idx" ON "Opportunity"("organizationId");
CREATE INDEX "Opportunity_stage_idx" ON "Opportunity"("stage");
CREATE INDEX "Opportunity_fundingStatus_idx" ON "Opportunity"("fundingStatus");
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- OpportunityStakeholder
CREATE TABLE "OpportunityStakeholder" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "OpportunityStakeholder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OpportunityStakeholder_opportunityId_contactId_key" ON "OpportunityStakeholder"("opportunityId", "contactId");
CREATE INDEX "OpportunityStakeholder_opportunityId_idx" ON "OpportunityStakeholder"("opportunityId");
ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Attachment
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "opportunityId" TEXT,
    "category" "AttachmentCategory" NOT NULL DEFAULT 'OTHER',
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
CREATE INDEX "Attachment_opportunityId_idx" ON "Attachment"("opportunityId");
CREATE INDEX "Attachment_organizationId_idx" ON "Attachment"("organizationId");
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

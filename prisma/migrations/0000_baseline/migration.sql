-- Baseline: the whole schema as it stands, generated from prisma/schema.prisma
-- with `prisma migrate diff --from-empty` on 6 August 2026.
--
-- WHY THIS EXISTS
--
-- Several tables — Sku and ProposalTemplate among them — were created by an early
-- `prisma db push` and no migration ever created them. Replaying the history from
-- empty therefore failed at 0016_sku_cost ("the underlying table for model Sku does
-- not exist"), which meant `prisma migrate dev` could not be used at all and a
-- fresh database could not be built from this repo.
--
-- This migration sorts before 0001_init and fills that gap. On the live databases
-- it is marked applied with `prisma migrate resolve --applied 0000_baseline` and
-- never runs. Against an empty database it builds everything, and the migrations
-- that follow then apply on top.
--
-- EVERY STATEMENT IS IDEMPOTENT, deliberately: CREATE TABLE and CREATE INDEX use
-- IF NOT EXISTS, and CREATE TYPE and ADD CONSTRAINT — which have no such form — are
-- wrapped in DO blocks that swallow duplicate_object. A baseline has to be a no-op
-- against a populated database and a full build against an empty one, or it is not
-- a baseline.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_REP', 'SALES_MANAGER', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'ACCOUNTING', 'PROJECT_MANAGER', 'INSTALLER', 'READ_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CustomerType" AS ENUM ('HEALTHCARE_SYSTEM', 'HOSPITAL', 'PRIVATE_PRACTICE', 'SCHOOL', 'UNIVERSITY', 'GOVERNMENT', 'NONPROFIT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OpportunityStage" AS ENUM ('PROSPECT', 'QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FundingStatus" AS ENUM ('UNFUNDED', 'BUDGETED', 'GRANT_PENDING', 'GRANT_AWARDED', 'APPROVED', 'SELF_FUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TherapyDiscipline" AS ENUM ('PHYSICAL', 'OCCUPATIONAL', 'SPEECH', 'ABA', 'SENSORY_INTEGRATION', 'RECREATIONAL', 'AQUATIC', 'PSYCHOLOGICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PatientPopulation" AS ENUM ('PEDIATRIC', 'ADOLESCENT', 'ADULT', 'GERIATRIC', 'SPECIAL_NEEDS', 'VETERANS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AddressType" AS ENUM ('BILLING', 'SHIPPING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FloorType" AS ENUM ('CARPET', 'VINYL', 'TILE', 'CONCRETE', 'HARDWOOD', 'RUBBER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WallConstruction" AS ENUM ('DRYWALL', 'CONCRETE_BLOCK', 'BRICK', 'PLASTER', 'GLASS', 'MODULAR', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AttachmentCategory" AS ENUM ('PHOTOGRAPH', 'FLOOR_PLAN', 'MEASUREMENT_DOC', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProductKind" AS ENUM ('PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RelationType" AS ENUM ('VARIANT_OF', 'COMPONENT_OF', 'BUNDLE_ITEM', 'ACCESSORY_OF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RuleType" AS ENUM ('REQUIRES', 'EXCLUDES', 'COMPATIBLE_WITH', 'INCOMPATIBLE_WITH', 'MIN_QUANTITY', 'MAX_QUANTITY', 'MIN_ROOM_DIMENSIONS', 'MIN_CEILING_HEIGHT', 'CLEARANCE', 'STRUCTURAL', 'INSTALLATION', 'FREIGHT', 'AUTO_INCLUDE_COMPONENT', 'AUTO_CALCULATED_COMPONENT', 'SUGGESTED_ACCESSORY', 'SUGGESTED_UPGRADE', 'APPROVAL_REQUIRED', 'MISSING_INFORMATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RuleOutcome" AS ENUM ('ALLOW', 'BLOCK', 'WARN', 'REQUIRE_APPROVAL', 'AUTO_ADD', 'RECOMMEND', 'REQUEST_INFORMATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'INTERNAL_REVIEW', 'RELEASED', 'ACCEPTED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "NotePlacement" AS ENUM ('TABLE', 'FOOTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ApprovalType" AS ENUM ('DISCOUNT', 'MARGIN_EXCEPTION', 'CUSTOM_PRICING', 'CUSTOM_PRODUCT', 'PRODUCT_RULE_OVERRIDE', 'FREIGHT_EXCEPTION', 'INSTALLATION_EXCEPTION', 'LEGAL_EXCEPTION', 'PAYMENT_TERM_EXCEPTION', 'PROPOSAL_RELEASE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'ESCALATED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SyncState" AS ENUM ('LINKED', 'PENDING', 'ERROR', 'CONFLICT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "QboEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "QboTxnType" AS ENUM ('ESTIMATE', 'INVOICE', 'DEPOSIT_INVOICE', 'PROGRESS_INVOICE', 'FINAL_INVOICE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "QboTxnStatus" AS ENUM ('DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'CREATED', 'FAILED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "HandoffStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'BLOCKED', 'READY', 'COMPLETE', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CustomerApprovalMethod" AS ENUM ('SIGNATURE', 'COUNTERSIGNED_PROPOSAL', 'PURCHASE_ORDER', 'EMAIL', 'VERBAL', 'PORTAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RequirementCategory" AS ENUM ('PRODUCTION', 'CUSTOM_PRODUCT', 'SHIPPING', 'INSTALLATION', 'TRAINING', 'CUSTOMER_RESPONSIBILITY', 'FACILITY_ACCESS', 'REQUIRED_DOCUMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RequirementStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'WAIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BomShipTo" AS ENUM ('CUSTOMER', 'SUMMIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "HandoffTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BomSectionStatus" AS ENUM ('DRAFT', 'SUBMITTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BomQuestionType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BomSendFormat" AS ENUM ('EXCEL', 'PDF', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BomSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'DELIVERED', 'BOUNCED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FreightRfqStatus" AS ENUM ('DRAFT', 'SENT', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FreightRfqSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READ_ONLY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetUserId" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL DEFAULT 'OTHER',
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxExemptId" TEXT,
    "notes" TEXT,
    "qboSalesTermId" TEXT,
    "qboSalesTermName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Contact" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "Address" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "Facility" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Room" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "Opportunity" (
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
    "mondayItemId" TEXT,
    "mondaySyncHash" TEXT,
    "mondaySyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OpportunityStakeholder" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OpportunityStakeholder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Attachment" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "IntegrationSyncLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'monday',
    "direction" "SyncDirection" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "externalId" TEXT,
    "eventId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductLine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "productLineId" TEXT,
    "tierLevel" INTEGER NOT NULL DEFAULT 1,
    "defaultQuantity" INTEGER,
    "productId" TEXT,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductFamily" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL DEFAULT 'PRODUCT',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "categoryId" TEXT NOT NULL,
    "familyId" TEXT,
    "productLineId" TEXT,
    "defaultQuantity" INTEGER NOT NULL DEFAULT 1,
    "badge" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "proposalDescription" TEXT,
    "internalDescription" TEXT,
    "lengthInLegacy" INTEGER,
    "widthInLegacy" INTEGER,
    "heightInLegacy" INTEGER,
    "lengthIn" DECIMAL(8,3),
    "widthIn" DECIMAL(8,3),
    "heightIn" DECIMAL(8,3),
    "thicknessIn" DECIMAL(8,3),
    "dimensionsOverride" TEXT,
    "showDimensions" BOOLEAN NOT NULL DEFAULT false,
    "weightOz" INTEGER,
    "capacity" TEXT,
    "activeFrom" TIMESTAMP(3),
    "activeTo" TIMESTAMP(3),
    "adminNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductNote" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Manufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isThirdParty" BOOLEAN NOT NULL DEFAULT true,
    "freightTbd" BOOLEAN NOT NULL DEFAULT false,
    "rfqAbbrev" TEXT,
    "defaultLeadTimeDays" INTEGER,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "contactTitle" TEXT,
    "contactPhone" TEXT,
    "altContactName" TEXT,
    "altContactEmail" TEXT,
    "altContactPhone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'USA',
    "website" TEXT,
    "accountNumber" TEXT,
    "paymentTerms" TEXT,
    "isSteelFabricator" BOOLEAN NOT NULL DEFAULT false,
    "bomEmailTo" TEXT,
    "bomEmailCc" TEXT,
    "bomEmailSubject" TEXT,
    "bomEmailBody" TEXT,
    "bomEmailFormat" "BomSendFormat" NOT NULL DEFAULT 'PDF',
    "bomShowPowderColor" BOOLEAN NOT NULL DEFAULT false,
    "rfqEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rfqContactName" TEXT,
    "rfqContactEmail" TEXT,
    "rfqContactPhone" TEXT,
    "rfqEmailTo" TEXT,
    "rfqEmailCc" TEXT,
    "rfqEmailSubject" TEXT,
    "rfqEmailBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductSourcing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "vendorPartNo" TEXT,
    "leadTimeDays" INTEGER,
    "minOrderQty" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSourcing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductRelation" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TechnicalDocument" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "title" TEXT,

    CONSTRAINT "TechnicalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductVersion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeNote" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductStatusHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromStatus" "ProductStatus",
    "toStatus" "ProductStatus" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Rule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "RuleType" NOT NULL,
    "outcome" "RuleOutcome" NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "changeNote" TEXT,
    "changedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RuleEvaluationSnapshot" (
    "id" TEXT NOT NULL,
    "subjectRef" TEXT,
    "engineVersion" TEXT NOT NULL,
    "rulesUsed" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleEvaluationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PriceList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PriceListStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PriceListEntry" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomerPrice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),

    CONSTRAINT "CustomerPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PromotionalPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "code" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),

    CONSTRAINT "PromotionalPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductCost" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "subjectRef" TEXT,
    "currency" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "ruleSnapshotId" TEXT,
    "input" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "grandTotal" BIGINT NOT NULL,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PriceOverrideLog" (
    "id" TEXT NOT NULL,
    "subjectRef" TEXT,
    "field" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceOverrideLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Proposal" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "qboSalesTermId" TEXT,
    "qboSalesTermName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProposalVersion" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProposalStatusEvent" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fromStatus" "ProposalStatus",
    "toStatus" "ProposalStatus" NOT NULL,
    "note" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProposalTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "data" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StandardNote" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "placement" "NotePlacement" NOT NULL DEFAULT 'TABLE',
    "autoInclude" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StandardNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "HardwareRule" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'HARDWARE',
    "part" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "constant" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "roundMode" TEXT NOT NULL DEFAULT 'NONE',
    "roundStep" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'SUM',
    "minZero" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "when" JSONB,
    "group" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HardwareRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FormulaSetting" (
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormulaSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Sku" (
    "id" TEXT NOT NULL,
    "part" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "unitCostMinor" INTEGER NOT NULL DEFAULT 0,
    "weightLbs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "manufacturer" TEXT,
    "proposalGroup" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "overrideAllowed" BOOLEAN NOT NULL DEFAULT false,
    "defaultQty" INTEGER,
    "freightMinor" INTEGER,
    "freightLabel" TEXT,
    "productUrl" TEXT,
    "requiresPowderColor" BOOLEAN NOT NULL DEFAULT false,
    "packagingBag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "subjectRef" TEXT,
    "proposalId" TEXT,
    "proposalVersion" INTEGER,
    "requesterId" TEXT NOT NULL,
    "approverId" TEXT,
    "reason" TEXT NOT NULL,
    "supportingInfo" JSONB,
    "originalValue" TEXT,
    "requestedValue" TEXT NOT NULL,
    "decision" "ApprovalStatus",
    "decisionNotes" TEXT,
    "decidedAt" TIMESTAMP(3),
    "escalatedToId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalDelegation" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "type" "ApprovalType",
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ExternalLink" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'monday',
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "boardId" TEXT,
    "lastSyncedHash" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "state" "SyncState" NOT NULL DEFAULT 'LINKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboConnection" (
    "id" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "environment" "QboEnvironment" NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "connectedById" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboEntityLink" (
    "id" TEXT NOT NULL,
    "environment" "QboEnvironment" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "qboSyncToken" TEXT,
    "lastSyncedHash" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "state" "SyncState" NOT NULL DEFAULT 'LINKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboEntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "QboTransaction" (
    "id" TEXT NOT NULL,
    "type" "QboTxnType" NOT NULL,
    "environment" "QboEnvironment" NOT NULL,
    "status" "QboTxnStatus" NOT NULL DEFAULT 'DRAFT',
    "proposalId" TEXT NOT NULL,
    "proposalVersionId" TEXT NOT NULL,
    "proposalVersion" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "proposalTotalMinor" BIGINT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "totalsSnapshot" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerQboId" TEXT,
    "qboId" TEXT,
    "qboDocNumber" TEXT,
    "qboSyncToken" TEXT,
    "initiatedById" TEXT NOT NULL,
    "authorizedById" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AcceptedOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "proposalId" TEXT NOT NULL,
    "proposalVersionId" TEXT NOT NULL,
    "acceptedVersion" INTEGER NOT NULL,
    "priceSnapshotId" TEXT NOT NULL,
    "ruleSnapshotId" TEXT,
    "currency" TEXT NOT NULL,
    "grandTotalMinor" BIGINT NOT NULL,
    "depositRequired" BOOLEAN NOT NULL DEFAULT false,
    "depositDueMinor" BIGINT NOT NULL DEFAULT 0,
    "contentSnapshot" JSONB NOT NULL,
    "integrityHash" TEXT NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'NEW',
    "locked" BOOLEAN NOT NULL DEFAULT true,
    "jobName" TEXT,
    "bomShipTo" "BomShipTo" NOT NULL DEFAULT 'CUSTOMER',
    "bomSubmittedOn" TIMESTAMP(3),
    "deliveryType" TEXT,
    "powderCoatBrand" TEXT,
    "shipmentQuote" TEXT,
    "bomNotes" TEXT,
    "qboEstimateTxnId" TEXT,
    "mondayProjectId" TEXT,
    "acceptedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcceptedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomerApproval" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "CustomerApprovalMethod" NOT NULL,
    "approverName" TEXT NOT NULL,
    "approverTitle" TEXT,
    "approverEmail" TEXT,
    "poNumber" TEXT,
    "documentRef" TEXT,
    "ipAddress" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProcurementLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "vendor" TEXT,
    "poNumber" TEXT,
    "sourced" BOOLEAN NOT NULL DEFAULT false,
    "unitCostMinor" INTEGER,
    "unitWeightLbs" DECIMAL(10,3),
    "powderColor" TEXT,
    "powderBrandId" TEXT,
    "powderColorCode" TEXT,
    "isHardwareComponent" BOOLEAN NOT NULL DEFAULT false,
    "kitSku" TEXT,
    "vendorNotes" TEXT,
    "targetDate" TIMESTAMP(3),
    "notes" TEXT,
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionReason" TEXT,

    CONSTRAINT "ProcurementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "HandoffRequirement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "status" "RequirementStatus" NOT NULL DEFAULT 'OPEN',
    "targetDate" TIMESTAMP(3),
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandoffRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "HandoffTask" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "RequirementCategory",
    "assigneeId" TEXT,
    "assigneeRole" "Role",
    "dueDate" TIMESTAMP(3),
    "status" "HandoffTaskStatus" NOT NULL DEFAULT 'TODO',
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandoffTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomVendorSection" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "jobName" TEXT,
    "shipTo" "BomShipTo" NOT NULL DEFAULT 'CUSTOMER',
    "submittedOn" TIMESTAMP(3),
    "deliveryType" TEXT,
    "powderCoatBrand" TEXT,
    "shipmentQuote" TEXT,
    "notes" TEXT,
    "status" "BomSectionStatus" NOT NULL DEFAULT 'DRAFT',
    "showPowderColor" BOOLEAN NOT NULL DEFAULT false,
    "showPackagingBag" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "unlockedAt" TIMESTAMP(3),
    "unlockedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomVendorSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomQuestionTemplate" (
    "id" TEXT NOT NULL,
    "vendor" TEXT,
    "label" TEXT NOT NULL,
    "type" "BomQuestionType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "helpText" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomQuestionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomVendorAnswer" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "templateId" TEXT,
    "label" TEXT NOT NULL,
    "type" "BomQuestionType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "value" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomVendorAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomSend" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmails" TEXT,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT,
    "format" "BomSendFormat" NOT NULL DEFAULT 'PDF',
    "status" "BomSendStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "BomSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PowderColorBrand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PowderColorBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FinanceFactor" (
    "id" TEXT NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "factor" DECIMAL(10,6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FreightRfq" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "vendorAbbrev" TEXT,
    "submission" INTEGER NOT NULL DEFAULT 1,
    "organizationId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "manufacturerId" TEXT,
    "projectId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "status" "FreightRfqStatus" NOT NULL DEFAULT 'DRAFT',
    "shipToName" TEXT NOT NULL,
    "shipToLine1" TEXT,
    "shipToLine2" TEXT,
    "shipToCity" TEXT,
    "shipToRegion" TEXT,
    "shipToPostal" TEXT,
    "shipToCountry" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "totalCostMinor" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreightRfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FreightRfqLine" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCostMinor" INTEGER NOT NULL DEFAULT 0,
    "extendedCostMinor" INTEGER NOT NULL DEFAULT 0,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "addedManually" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FreightRfqLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FreightRfqSend" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "ccEmails" TEXT,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT NOT NULL,
    "status" "FreightRfqSendStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreightRfqSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_targetUserId_idx" ON "AuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Organization_customerType_idx" ON "Organization"("customerType");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_normalizedName_key" ON "Organization"("normalizedName");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contact_organizationId_idx" ON "Contact"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Address_organizationId_idx" ON "Address"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Facility_organizationId_idx" ON "Facility"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Room_facilityId_idx" ON "Room"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Opportunity_mondayItemId_key" ON "Opportunity"("mondayItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_organizationId_idx" ON "Opportunity"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_stage_idx" ON "Opportunity"("stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_fundingStatus_idx" ON "Opportunity"("fundingStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityStakeholder_opportunityId_idx" ON "OpportunityStakeholder"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OpportunityStakeholder_opportunityId_contactId_key" ON "OpportunityStakeholder"("opportunityId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Attachment_opportunityId_idx" ON "Attachment"("opportunityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Attachment_organizationId_idx" ON "Attachment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationSyncLog_eventId_key" ON "IntegrationSyncLog"("eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IntegrationSyncLog_entity_entityId_idx" ON "IntegrationSyncLog"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductLine_name_key" ON "ProductLine"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductLine_slug_key" ON "ProductLine"("slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductCategory_slug_key" ON "ProductCategory"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductCategory_productLineId_tierLevel_idx" ON "ProductCategory"("productLineId", "tierLevel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductCategory_parentId_sortOrder_idx" ON "ProductCategory"("parentId", "sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductFamily_categoryId_idx" ON "ProductFamily"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductFamily_categoryId_slug_key" ON "ProductFamily"("categoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_familyId_idx" ON "Product"("familyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_kind_idx" ON "Product"("kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_productLineId_idx" ON "Product"("productLineId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_sortOrder_idx" ON "Product"("sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductNote_productId_idx" ON "ProductNote"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Manufacturer_name_key" ON "Manufacturer"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Manufacturer_slug_key" ON "Manufacturer"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductSourcing_manufacturerId_idx" ON "ProductSourcing"("manufacturerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductSourcing_productId_manufacturerId_key" ON "ProductSourcing"("productId", "manufacturerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductRelation_childId_idx" ON "ProductRelation"("childId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductRelation_parentId_childId_type_key" ON "ProductRelation"("parentId", "childId", "type");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductImage_storageKey_key" ON "ProductImage"("storageKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TechnicalDocument_storageKey_key" ON "TechnicalDocument"("storageKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TechnicalDocument_productId_idx" ON "TechnicalDocument"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductVersion_productId_idx" ON "ProductVersion"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductVersion_productId_version_key" ON "ProductVersion"("productId", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductStatusHistory_productId_idx" ON "ProductStatusHistory"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Rule_key_key" ON "Rule"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rule_status_idx" ON "Rule"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rule_type_idx" ON "Rule"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RuleVersion_ruleId_idx" ON "RuleVersion"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RuleEvaluationSnapshot_subjectRef_idx" ON "RuleEvaluationSnapshot"("subjectRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PriceList_status_idx" ON "PriceList"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PriceList_effectiveDate_idx" ON "PriceList"("effectiveDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PriceListEntry_productId_idx" ON "PriceListEntry"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PriceListEntry_priceListId_productId_minQuantity_key" ON "PriceListEntry"("priceListId", "productId", "minQuantity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CustomerPrice_organizationId_productId_idx" ON "CustomerPrice"("organizationId", "productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PromotionalPrice_productId_idx" ON "PromotionalPrice"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductCost_productId_effectiveDate_idx" ON "ProductCost"("productId", "effectiveDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PriceSnapshot_subjectRef_idx" ON "PriceSnapshot"("subjectRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PriceOverrideLog_subjectRef_idx" ON "PriceOverrideLog"("subjectRef");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Proposal_number_key" ON "Proposal"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Proposal_organizationId_idx" ON "Proposal"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalVersion_proposalId_idx" ON "ProposalVersion"("proposalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalVersion_status_idx" ON "ProposalVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProposalVersion_proposalId_version_key" ON "ProposalVersion"("proposalId", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalStatusEvent_versionId_idx" ON "ProposalStatusEvent"("versionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProposalTemplate_name_idx" ON "ProposalTemplate"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StandardNote_active_placement_sortOrder_idx" ON "StandardNote"("active", "placement", "sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HardwareRule_sortOrder_idx" ON "HardwareRule"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "HardwareRule_kind_part_key" ON "HardwareRule"("kind", "part");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Sku_part_key" ON "Sku"("part");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Sku_category_idx" ON "Sku"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Sku_active_idx" ON "Sku"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_type_idx" ON "ApprovalRequest"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_approverId_idx" ON "ApprovalRequest"("approverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_proposalId_proposalVersion_idx" ON "ApprovalRequest"("proposalId", "proposalVersion");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalEvent_requestId_idx" ON "ApprovalEvent"("requestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalDelegation_toUserId_idx" ON "ApprovalDelegation"("toUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalDelegation_fromUserId_idx" ON "ApprovalDelegation"("fromUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExternalLink_entity_entityId_idx" ON "ExternalLink"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalLink_provider_entity_entityId_key" ON "ExternalLink"("provider", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalLink_provider_externalId_key" ON "ExternalLink"("provider", "externalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboConnection_environment_idx" ON "QboConnection"("environment");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboConnection_realmId_environment_key" ON "QboConnection"("realmId", "environment");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboEntityLink_entity_entityId_idx" ON "QboEntityLink"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboEntityLink_environment_entity_entityId_key" ON "QboEntityLink"("environment", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboEntityLink_environment_entity_qboId_key" ON "QboEntityLink"("environment", "entity", "qboId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "QboTransaction_idempotencyKey_key" ON "QboTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboTransaction_proposalId_proposalVersion_idx" ON "QboTransaction"("proposalId", "proposalVersion");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboTransaction_status_idx" ON "QboTransaction"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboTransaction_type_idx" ON "QboTransaction"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QboTransaction_environment_idx" ON "QboTransaction"("environment");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AcceptedOrder_number_key" ON "AcceptedOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AcceptedOrder_proposalVersionId_key" ON "AcceptedOrder"("proposalVersionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AcceptedOrder_organizationId_idx" ON "AcceptedOrder"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AcceptedOrder_status_idx" ON "AcceptedOrder"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AcceptedOrder_proposalId_idx" ON "AcceptedOrder"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerApproval_orderId_key" ON "CustomerApproval"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementLine_orderId_idx" ON "ProcurementLine"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffRequirement_orderId_idx" ON "HandoffRequirement"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffRequirement_category_idx" ON "HandoffRequirement"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffRequirement_status_idx" ON "HandoffRequirement"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffTask_orderId_idx" ON "HandoffTask"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffTask_assigneeId_idx" ON "HandoffTask"("assigneeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HandoffTask_status_idx" ON "HandoffTask"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomVendorSection_orderId_idx" ON "BomVendorSection"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BomVendorSection_orderId_vendor_key" ON "BomVendorSection"("orderId", "vendor");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomQuestionTemplate_vendor_idx" ON "BomQuestionTemplate"("vendor");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomVendorAnswer_sectionId_idx" ON "BomVendorAnswer"("sectionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomSend_sectionId_idx" ON "BomSend"("sectionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomSend_orderId_idx" ON "BomSend"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomSend_providerMessageId_idx" ON "BomSend"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PowderColorBrand_name_key" ON "PowderColorBrand"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FinanceFactor_termMonths_key" ON "FinanceFactor"("termMonths");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfq_versionId_idx" ON "FreightRfq"("versionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfq_organizationId_idx" ON "FreightRfq"("organizationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfq_status_idx" ON "FreightRfq"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FreightRfq_proposalId_vendor_revision_key" ON "FreightRfq"("proposalId", "vendor", "revision");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfqLine_rfqId_idx" ON "FreightRfqLine"("rfqId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FreightRfqSend_rfqId_idx" ON "FreightRfqSend"("rfqId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Address" ADD CONSTRAINT "Address_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Facility" ADD CONSTRAINT "Facility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Room" ADD CONSTRAINT "Room_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT "Product_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT "Product_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductNote" ADD CONSTRAINT "ProductNote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TechnicalDocument" ADD CONSTRAINT "TechnicalDocument_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProductStatusHistory" ADD CONSTRAINT "ProductStatusHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProposalStatusEvent" ADD CONSTRAINT "ProposalStatusEvent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ProposalVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "CustomerApproval" ADD CONSTRAINT "CustomerApproval_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProcurementLine" ADD CONSTRAINT "ProcurementLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ProcurementLine" ADD CONSTRAINT "ProcurementLine_powderBrandId_fkey" FOREIGN KEY ("powderBrandId") REFERENCES "PowderColorBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "HandoffRequirement" ADD CONSTRAINT "HandoffRequirement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "HandoffTask" ADD CONSTRAINT "HandoffTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BomVendorSection" ADD CONSTRAINT "BomVendorSection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BomVendorAnswer" ADD CONSTRAINT "BomVendorAnswer_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BomSend" ADD CONSTRAINT "BomSend_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FreightRfq" ADD CONSTRAINT "FreightRfq_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FreightRfq" ADD CONSTRAINT "FreightRfq_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FreightRfqLine" ADD CONSTRAINT "FreightRfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "FreightRfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FreightRfqSend" ADD CONSTRAINT "FreightRfqSend_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "FreightRfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_REP', 'SALES_MANAGER', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'ACCOUNTING', 'PROJECT_MANAGER', 'INSTALLER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('HEALTHCARE_SYSTEM', 'HOSPITAL', 'PRIVATE_PRACTICE', 'SCHOOL', 'UNIVERSITY', 'GOVERNMENT', 'NONPROFIT', 'OTHER');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('PROSPECT', 'QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST');

-- CreateEnum
CREATE TYPE "FundingStatus" AS ENUM ('UNFUNDED', 'BUDGETED', 'GRANT_PENDING', 'GRANT_AWARDED', 'APPROVED', 'SELF_FUNDED');

-- CreateEnum
CREATE TYPE "TherapyDiscipline" AS ENUM ('PHYSICAL', 'OCCUPATIONAL', 'SPEECH', 'ABA', 'SENSORY_INTEGRATION', 'RECREATIONAL', 'AQUATIC', 'PSYCHOLOGICAL');

-- CreateEnum
CREATE TYPE "PatientPopulation" AS ENUM ('PEDIATRIC', 'ADOLESCENT', 'ADULT', 'GERIATRIC', 'SPECIAL_NEEDS', 'VETERANS');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('BILLING', 'SHIPPING');

-- CreateEnum
CREATE TYPE "FloorType" AS ENUM ('CARPET', 'VINYL', 'TILE', 'CONCRETE', 'HARDWOOD', 'RUBBER', 'OTHER');

-- CreateEnum
CREATE TYPE "WallConstruction" AS ENUM ('DRYWALL', 'CONCRETE_BLOCK', 'BRICK', 'PLASTER', 'GLASS', 'MODULAR', 'OTHER');

-- CreateEnum
CREATE TYPE "AttachmentCategory" AS ENUM ('PHOTOGRAPH', 'FLOOR_PLAN', 'MEASUREMENT_DOC', 'OTHER');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('VARIANT_OF', 'COMPONENT_OF', 'BUNDLE_ITEM', 'ACCESSORY_OF');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('REQUIRES', 'EXCLUDES', 'COMPATIBLE_WITH', 'INCOMPATIBLE_WITH', 'MIN_QUANTITY', 'MAX_QUANTITY', 'MIN_ROOM_DIMENSIONS', 'MIN_CEILING_HEIGHT', 'CLEARANCE', 'STRUCTURAL', 'INSTALLATION', 'FREIGHT', 'AUTO_INCLUDE_COMPONENT', 'AUTO_CALCULATED_COMPONENT', 'SUGGESTED_ACCESSORY', 'SUGGESTED_UPGRADE', 'APPROVAL_REQUIRED', 'MISSING_INFORMATION');

-- CreateEnum
CREATE TYPE "RuleOutcome" AS ENUM ('ALLOW', 'BLOCK', 'WARN', 'REQUIRE_APPROVAL', 'AUTO_ADD', 'RECOMMEND', 'REQUEST_INFORMATION');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "PriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'INTERNAL_REVIEW', 'RELEASED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotePlacement" AS ENUM ('TABLE', 'FOOTER');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('DISCOUNT', 'MARGIN_EXCEPTION', 'CUSTOM_PRICING', 'CUSTOM_PRODUCT', 'PRODUCT_RULE_OVERRIDE', 'FREIGHT_EXCEPTION', 'INSTALLATION_EXCEPTION', 'LEGAL_EXCEPTION', 'PAYMENT_TERM_EXCEPTION', 'PROPOSAL_RELEASE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'ESCALATED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('LINKED', 'PENDING', 'ERROR', 'CONFLICT');

-- CreateEnum
CREATE TYPE "QboEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "QboTxnType" AS ENUM ('ESTIMATE', 'INVOICE', 'DEPOSIT_INVOICE', 'PROGRESS_INVOICE', 'FINAL_INVOICE');

-- CreateEnum
CREATE TYPE "QboTxnStatus" AS ENUM ('DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'CREATED', 'FAILED', 'VOIDED');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'BLOCKED', 'READY', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerApprovalMethod" AS ENUM ('SIGNATURE', 'COUNTERSIGNED_PROPOSAL', 'PURCHASE_ORDER', 'EMAIL', 'VERBAL', 'PORTAL');

-- CreateEnum
CREATE TYPE "RequirementCategory" AS ENUM ('PRODUCTION', 'CUSTOM_PRODUCT', 'SHIPPING', 'INSTALLATION', 'TRAINING', 'CUSTOMER_RESPONSIBILITY', 'FACILITY_ACCESS', 'REQUIRED_DOCUMENT');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'WAIVED');

-- CreateEnum
CREATE TYPE "BomShipTo" AS ENUM ('CUSTOMER', 'SUMMIT');

-- CreateEnum
CREATE TYPE "HandoffTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BomSectionStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "BomQuestionType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "BomSendFormat" AS ENUM ('EXCEL', 'PDF', 'BOTH');

-- CreateEnum
CREATE TYPE "BomSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'DELIVERED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "FreightRfqStatus" AS ENUM ('DRAFT', 'SENT', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "FreightRfqSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
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
CREATE TABLE "PasswordResetToken" (
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
CREATE TABLE "Session" (
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
CREATE TABLE "AuditLog" (
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
CREATE TABLE "Organization" (
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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
    "mondayItemId" TEXT,
    "mondaySyncHash" TEXT,
    "mondaySyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityStakeholder" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OpportunityStakeholder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "IntegrationSyncLog" (
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
CREATE TABLE "ProductLine" (
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
CREATE TABLE "ProductCategory" (
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
CREATE TABLE "ProductFamily" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "ProductFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
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
CREATE TABLE "ProductNote" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Manufacturer" (
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
CREATE TABLE "ProductSourcing" (
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
CREATE TABLE "ProductRelation" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
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
CREATE TABLE "TechnicalDocument" (
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
CREATE TABLE "ProductVersion" (
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
CREATE TABLE "ProductStatusHistory" (
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
CREATE TABLE "Rule" (
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
CREATE TABLE "RuleVersion" (
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
CREATE TABLE "RuleEvaluationSnapshot" (
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
CREATE TABLE "PriceList" (
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
CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPrice" (
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
CREATE TABLE "PromotionalPrice" (
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
CREATE TABLE "ProductCost" (
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
CREATE TABLE "PriceSnapshot" (
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
CREATE TABLE "PriceOverrideLog" (
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
CREATE TABLE "Proposal" (
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "ProposalTemplate" (
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
CREATE TABLE "StandardNote" (
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
CREATE TABLE "HardwareRule" (
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
CREATE TABLE "FormulaSetting" (
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormulaSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Sku" (
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
CREATE TABLE "ApprovalRequest" (
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
CREATE TABLE "ApprovalEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
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
CREATE TABLE "ExternalLink" (
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
CREATE TABLE "QboConnection" (
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
CREATE TABLE "QboEntityLink" (
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
CREATE TABLE "QboTransaction" (
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
CREATE TABLE "AcceptedOrder" (
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
CREATE TABLE "CustomerApproval" (
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
CREATE TABLE "ProcurementLine" (
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
CREATE TABLE "HandoffRequirement" (
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
CREATE TABLE "HandoffTask" (
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
CREATE TABLE "BomVendorSection" (
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
CREATE TABLE "BomQuestionTemplate" (
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
CREATE TABLE "BomVendorAnswer" (
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
CREATE TABLE "BomSend" (
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
CREATE TABLE "PowderColorBrand" (
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
CREATE TABLE "FinanceFactor" (
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
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreightRfq" (
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
CREATE TABLE "FreightRfqLine" (
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
CREATE TABLE "FreightRfqSend" (
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
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_targetUserId_idx" ON "AuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "Organization_customerType_idx" ON "Organization"("customerType");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_normalizedName_key" ON "Organization"("normalizedName");

-- CreateIndex
CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Address_organizationId_idx" ON "Address"("organizationId");

-- CreateIndex
CREATE INDEX "Facility_organizationId_idx" ON "Facility"("organizationId");

-- CreateIndex
CREATE INDEX "Room_facilityId_idx" ON "Room"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_mondayItemId_key" ON "Opportunity"("mondayItemId");

-- CreateIndex
CREATE INDEX "Opportunity_organizationId_idx" ON "Opportunity"("organizationId");

-- CreateIndex
CREATE INDEX "Opportunity_stage_idx" ON "Opportunity"("stage");

-- CreateIndex
CREATE INDEX "Opportunity_fundingStatus_idx" ON "Opportunity"("fundingStatus");

-- CreateIndex
CREATE INDEX "OpportunityStakeholder_opportunityId_idx" ON "OpportunityStakeholder"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityStakeholder_opportunityId_contactId_key" ON "OpportunityStakeholder"("opportunityId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_opportunityId_idx" ON "Attachment"("opportunityId");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_idx" ON "Attachment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSyncLog_eventId_key" ON "IntegrationSyncLog"("eventId");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_entity_entityId_idx" ON "IntegrationSyncLog"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLine_name_key" ON "ProductLine"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLine_slug_key" ON "ProductLine"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_slug_key" ON "ProductCategory"("slug");

-- CreateIndex
CREATE INDEX "ProductCategory_productLineId_tierLevel_idx" ON "ProductCategory"("productLineId", "tierLevel");

-- CreateIndex
CREATE INDEX "ProductCategory_parentId_sortOrder_idx" ON "ProductCategory"("parentId", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductFamily_categoryId_idx" ON "ProductFamily"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFamily_categoryId_slug_key" ON "ProductFamily"("categoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_familyId_idx" ON "Product"("familyId");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "Product_kind_idx" ON "Product"("kind");

-- CreateIndex
CREATE INDEX "Product_productLineId_idx" ON "Product"("productLineId");

-- CreateIndex
CREATE INDEX "Product_sortOrder_idx" ON "Product"("sortOrder");

-- CreateIndex
CREATE INDEX "ProductNote_productId_idx" ON "ProductNote"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_slug_key" ON "Manufacturer"("slug");

-- CreateIndex
CREATE INDEX "ProductSourcing_manufacturerId_idx" ON "ProductSourcing"("manufacturerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSourcing_productId_manufacturerId_key" ON "ProductSourcing"("productId", "manufacturerId");

-- CreateIndex
CREATE INDEX "ProductRelation_childId_idx" ON "ProductRelation"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_parentId_childId_type_key" ON "ProductRelation"("parentId", "childId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_storageKey_key" ON "ProductImage"("storageKey");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalDocument_storageKey_key" ON "TechnicalDocument"("storageKey");

-- CreateIndex
CREATE INDEX "TechnicalDocument_productId_idx" ON "TechnicalDocument"("productId");

-- CreateIndex
CREATE INDEX "ProductVersion_productId_idx" ON "ProductVersion"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_productId_version_key" ON "ProductVersion"("productId", "version");

-- CreateIndex
CREATE INDEX "ProductStatusHistory_productId_idx" ON "ProductStatusHistory"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_key_key" ON "Rule"("key");

-- CreateIndex
CREATE INDEX "Rule_status_idx" ON "Rule"("status");

-- CreateIndex
CREATE INDEX "Rule_type_idx" ON "Rule"("type");

-- CreateIndex
CREATE INDEX "RuleVersion_ruleId_idx" ON "RuleVersion"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "RuleEvaluationSnapshot_subjectRef_idx" ON "RuleEvaluationSnapshot"("subjectRef");

-- CreateIndex
CREATE INDEX "PriceList_status_idx" ON "PriceList"("status");

-- CreateIndex
CREATE INDEX "PriceList_effectiveDate_idx" ON "PriceList"("effectiveDate");

-- CreateIndex
CREATE INDEX "PriceListEntry_productId_idx" ON "PriceListEntry"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListEntry_priceListId_productId_minQuantity_key" ON "PriceListEntry"("priceListId", "productId", "minQuantity");

-- CreateIndex
CREATE INDEX "CustomerPrice_organizationId_productId_idx" ON "CustomerPrice"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "PromotionalPrice_productId_idx" ON "PromotionalPrice"("productId");

-- CreateIndex
CREATE INDEX "ProductCost_productId_effectiveDate_idx" ON "ProductCost"("productId", "effectiveDate");

-- CreateIndex
CREATE INDEX "PriceSnapshot_subjectRef_idx" ON "PriceSnapshot"("subjectRef");

-- CreateIndex
CREATE INDEX "PriceOverrideLog_subjectRef_idx" ON "PriceOverrideLog"("subjectRef");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_number_key" ON "Proposal"("number");

-- CreateIndex
CREATE INDEX "Proposal_organizationId_idx" ON "Proposal"("organizationId");

-- CreateIndex
CREATE INDEX "ProposalVersion_proposalId_idx" ON "ProposalVersion"("proposalId");

-- CreateIndex
CREATE INDEX "ProposalVersion_status_idx" ON "ProposalVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVersion_proposalId_version_key" ON "ProposalVersion"("proposalId", "version");

-- CreateIndex
CREATE INDEX "ProposalStatusEvent_versionId_idx" ON "ProposalStatusEvent"("versionId");

-- CreateIndex
CREATE INDEX "ProposalTemplate_name_idx" ON "ProposalTemplate"("name");

-- CreateIndex
CREATE INDEX "StandardNote_active_placement_sortOrder_idx" ON "StandardNote"("active", "placement", "sortOrder");

-- CreateIndex
CREATE INDEX "HardwareRule_sortOrder_idx" ON "HardwareRule"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareRule_kind_part_key" ON "HardwareRule"("kind", "part");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_part_key" ON "Sku"("part");

-- CreateIndex
CREATE INDEX "Sku_category_idx" ON "Sku"("category");

-- CreateIndex
CREATE INDEX "Sku_active_idx" ON "Sku"("active");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_type_idx" ON "ApprovalRequest"("type");

-- CreateIndex
CREATE INDEX "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_approverId_idx" ON "ApprovalRequest"("approverId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_proposalId_proposalVersion_idx" ON "ApprovalRequest"("proposalId", "proposalVersion");

-- CreateIndex
CREATE INDEX "ApprovalEvent_requestId_idx" ON "ApprovalEvent"("requestId");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_toUserId_idx" ON "ApprovalDelegation"("toUserId");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_fromUserId_idx" ON "ApprovalDelegation"("fromUserId");

-- CreateIndex
CREATE INDEX "ExternalLink_entity_entityId_idx" ON "ExternalLink"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalLink_provider_entity_entityId_key" ON "ExternalLink"("provider", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalLink_provider_externalId_key" ON "ExternalLink"("provider", "externalId");

-- CreateIndex
CREATE INDEX "QboConnection_environment_idx" ON "QboConnection"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "QboConnection_realmId_environment_key" ON "QboConnection"("realmId", "environment");

-- CreateIndex
CREATE INDEX "QboEntityLink_entity_entityId_idx" ON "QboEntityLink"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "QboEntityLink_environment_entity_entityId_key" ON "QboEntityLink"("environment", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "QboEntityLink_environment_entity_qboId_key" ON "QboEntityLink"("environment", "entity", "qboId");

-- CreateIndex
CREATE UNIQUE INDEX "QboTransaction_idempotencyKey_key" ON "QboTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "QboTransaction_proposalId_proposalVersion_idx" ON "QboTransaction"("proposalId", "proposalVersion");

-- CreateIndex
CREATE INDEX "QboTransaction_status_idx" ON "QboTransaction"("status");

-- CreateIndex
CREATE INDEX "QboTransaction_type_idx" ON "QboTransaction"("type");

-- CreateIndex
CREATE INDEX "QboTransaction_environment_idx" ON "QboTransaction"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptedOrder_number_key" ON "AcceptedOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptedOrder_proposalVersionId_key" ON "AcceptedOrder"("proposalVersionId");

-- CreateIndex
CREATE INDEX "AcceptedOrder_organizationId_idx" ON "AcceptedOrder"("organizationId");

-- CreateIndex
CREATE INDEX "AcceptedOrder_status_idx" ON "AcceptedOrder"("status");

-- CreateIndex
CREATE INDEX "AcceptedOrder_proposalId_idx" ON "AcceptedOrder"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerApproval_orderId_key" ON "CustomerApproval"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementLine_orderId_idx" ON "ProcurementLine"("orderId");

-- CreateIndex
CREATE INDEX "HandoffRequirement_orderId_idx" ON "HandoffRequirement"("orderId");

-- CreateIndex
CREATE INDEX "HandoffRequirement_category_idx" ON "HandoffRequirement"("category");

-- CreateIndex
CREATE INDEX "HandoffRequirement_status_idx" ON "HandoffRequirement"("status");

-- CreateIndex
CREATE INDEX "HandoffTask_orderId_idx" ON "HandoffTask"("orderId");

-- CreateIndex
CREATE INDEX "HandoffTask_assigneeId_idx" ON "HandoffTask"("assigneeId");

-- CreateIndex
CREATE INDEX "HandoffTask_status_idx" ON "HandoffTask"("status");

-- CreateIndex
CREATE INDEX "BomVendorSection_orderId_idx" ON "BomVendorSection"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "BomVendorSection_orderId_vendor_key" ON "BomVendorSection"("orderId", "vendor");

-- CreateIndex
CREATE INDEX "BomQuestionTemplate_vendor_idx" ON "BomQuestionTemplate"("vendor");

-- CreateIndex
CREATE INDEX "BomVendorAnswer_sectionId_idx" ON "BomVendorAnswer"("sectionId");

-- CreateIndex
CREATE INDEX "BomSend_sectionId_idx" ON "BomSend"("sectionId");

-- CreateIndex
CREATE INDEX "BomSend_orderId_idx" ON "BomSend"("orderId");

-- CreateIndex
CREATE INDEX "BomSend_providerMessageId_idx" ON "BomSend"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "PowderColorBrand_name_key" ON "PowderColorBrand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceFactor_termMonths_key" ON "FinanceFactor"("termMonths");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

-- CreateIndex
CREATE INDEX "FreightRfq_versionId_idx" ON "FreightRfq"("versionId");

-- CreateIndex
CREATE INDEX "FreightRfq_organizationId_idx" ON "FreightRfq"("organizationId");

-- CreateIndex
CREATE INDEX "FreightRfq_status_idx" ON "FreightRfq"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FreightRfq_proposalId_vendor_revision_key" ON "FreightRfq"("proposalId", "vendor", "revision");

-- CreateIndex
CREATE INDEX "FreightRfqLine_rfqId_idx" ON "FreightRfqLine"("rfqId");

-- CreateIndex
CREATE INDEX "FreightRfqSend_rfqId_idx" ON "FreightRfqSend"("rfqId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityStakeholder" ADD CONSTRAINT "OpportunityStakeholder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFamily" ADD CONSTRAINT "ProductFamily_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "ProductLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductNote" ADD CONSTRAINT "ProductNote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSourcing" ADD CONSTRAINT "ProductSourcing_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalDocument" ADD CONSTRAINT "TechnicalDocument_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStatusHistory" ADD CONSTRAINT "ProductStatusHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalStatusEvent" ADD CONSTRAINT "ProposalStatusEvent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ProposalVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerApproval" ADD CONSTRAINT "CustomerApproval_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementLine" ADD CONSTRAINT "ProcurementLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementLine" ADD CONSTRAINT "ProcurementLine_powderBrandId_fkey" FOREIGN KEY ("powderBrandId") REFERENCES "PowderColorBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffRequirement" ADD CONSTRAINT "HandoffRequirement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffTask" ADD CONSTRAINT "HandoffTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomVendorSection" ADD CONSTRAINT "BomVendorSection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomVendorAnswer" ADD CONSTRAINT "BomVendorAnswer_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomSend" ADD CONSTRAINT "BomSend_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreightRfq" ADD CONSTRAINT "FreightRfq_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreightRfq" ADD CONSTRAINT "FreightRfq_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreightRfqLine" ADD CONSTRAINT "FreightRfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "FreightRfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreightRfqSend" ADD CONSTRAINT "FreightRfqSend_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "FreightRfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TYPE "HandoffStatus" AS ENUM ('NEW','IN_PROGRESS','BLOCKED','READY','COMPLETE','CANCELLED');
CREATE TYPE "CustomerApprovalMethod" AS ENUM ('SIGNATURE','COUNTERSIGNED_PROPOSAL','PURCHASE_ORDER','EMAIL','VERBAL','PORTAL');
CREATE TYPE "RequirementCategory" AS ENUM ('PRODUCTION','CUSTOM_PRODUCT','SHIPPING','INSTALLATION','TRAINING','CUSTOMER_RESPONSIBILITY','FACILITY_ACCESS','REQUIRED_DOCUMENT');
CREATE TYPE "RequirementStatus" AS ENUM ('OPEN','IN_PROGRESS','BLOCKED','COMPLETE','WAIVED');
CREATE TYPE "HandoffTaskStatus" AS ENUM ('TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED');

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
    "qboEstimateTxnId" TEXT,
    "mondayProjectId" TEXT,
    "acceptedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AcceptedOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcceptedOrder_number_key" ON "AcceptedOrder"("number");
CREATE UNIQUE INDEX "AcceptedOrder_proposalVersionId_key" ON "AcceptedOrder"("proposalVersionId");
CREATE INDEX "AcceptedOrder_organizationId_idx" ON "AcceptedOrder"("organizationId");
CREATE INDEX "AcceptedOrder_status_idx" ON "AcceptedOrder"("status");
CREATE INDEX "AcceptedOrder_proposalId_idx" ON "AcceptedOrder"("proposalId");

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
CREATE UNIQUE INDEX "CustomerApproval_orderId_key" ON "CustomerApproval"("orderId");

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
    "targetDate" TIMESTAMP(3),
    "notes" TEXT,
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionReason" TEXT,
    CONSTRAINT "ProcurementLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProcurementLine_orderId_idx" ON "ProcurementLine"("orderId");

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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandoffRequirement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HandoffRequirement_orderId_idx" ON "HandoffRequirement"("orderId");
CREATE INDEX "HandoffRequirement_category_idx" ON "HandoffRequirement"("category");
CREATE INDEX "HandoffRequirement_status_idx" ON "HandoffRequirement"("status");

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
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandoffTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HandoffTask_orderId_idx" ON "HandoffTask"("orderId");
CREATE INDEX "HandoffTask_assigneeId_idx" ON "HandoffTask"("assigneeId");
CREATE INDEX "HandoffTask_status_idx" ON "HandoffTask"("status");

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

ALTER TABLE "CustomerApproval" ADD CONSTRAINT "CustomerApproval_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcurementLine" ADD CONSTRAINT "ProcurementLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoffRequirement" ADD CONSTRAINT "HandoffRequirement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoffTask" ADD CONSTRAINT "HandoffTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "ApprovalType" AS ENUM ('DISCOUNT','MARGIN_EXCEPTION','CUSTOM_PRICING','CUSTOM_PRODUCT','PRODUCT_RULE_OVERRIDE','FREIGHT_EXCEPTION','INSTALLATION_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_TERM_EXCEPTION','PROPOSAL_RELEASE');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED','REVISION_REQUESTED','ESCALATED','EXPIRED','CANCELLED');

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
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");
CREATE INDEX "ApprovalRequest_type_idx" ON "ApprovalRequest"("type");
CREATE INDEX "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");
CREATE INDEX "ApprovalRequest_approverId_idx" ON "ApprovalRequest"("approverId");
CREATE INDEX "ApprovalRequest_proposalId_proposalVersion_idx" ON "ApprovalRequest"("proposalId", "proposalVersion");

CREATE TABLE "ApprovalEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalEvent_requestId_idx" ON "ApprovalEvent"("requestId");
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
CREATE INDEX "ApprovalDelegation_toUserId_idx" ON "ApprovalDelegation"("toUserId");
CREATE INDEX "ApprovalDelegation_fromUserId_idx" ON "ApprovalDelegation"("fromUserId");

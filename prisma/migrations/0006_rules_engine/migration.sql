CREATE TYPE "RuleType" AS ENUM (
  'REQUIRES','EXCLUDES','COMPATIBLE_WITH','INCOMPATIBLE_WITH','MIN_QUANTITY','MAX_QUANTITY',
  'MIN_ROOM_DIMENSIONS','MIN_CEILING_HEIGHT','CLEARANCE','STRUCTURAL','INSTALLATION','FREIGHT',
  'AUTO_INCLUDE_COMPONENT','AUTO_CALCULATED_COMPONENT','SUGGESTED_ACCESSORY','SUGGESTED_UPGRADE',
  'APPROVAL_REQUIRED','MISSING_INFORMATION'
);
CREATE TYPE "RuleOutcome" AS ENUM ('ALLOW','BLOCK','WARN','REQUIRE_APPROVAL','AUTO_ADD','RECOMMEND','REQUEST_INFORMATION');
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT','ACTIVE','RETIRED');

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
CREATE UNIQUE INDEX "Rule_key_key" ON "Rule"("key");
CREATE INDEX "Rule_status_idx" ON "Rule"("status");
CREATE INDEX "Rule_type_idx" ON "Rule"("type");

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
CREATE UNIQUE INDEX "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");
CREATE INDEX "RuleVersion_ruleId_idx" ON "RuleVersion"("ruleId");
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
CREATE INDEX "RuleEvaluationSnapshot_subjectRef_idx" ON "RuleEvaluationSnapshot"("subjectRef");

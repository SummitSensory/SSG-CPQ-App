CREATE TYPE "QboEnvironment" AS ENUM ('SANDBOX','PRODUCTION');
CREATE TYPE "QboTxnType" AS ENUM ('ESTIMATE','DEPOSIT_INVOICE','PROGRESS_INVOICE','FINAL_INVOICE');
CREATE TYPE "QboTxnStatus" AS ENUM ('DRAFT','PENDING_AUTHORIZATION','AUTHORIZED','CREATED','FAILED','VOIDED');

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
CREATE UNIQUE INDEX "QboConnection_realmId_environment_key" ON "QboConnection"("realmId", "environment");
CREATE INDEX "QboConnection_environment_idx" ON "QboConnection"("environment");

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
CREATE UNIQUE INDEX "QboEntityLink_environment_entity_entityId_key" ON "QboEntityLink"("environment", "entity", "entityId");
CREATE UNIQUE INDEX "QboEntityLink_environment_entity_qboId_key" ON "QboEntityLink"("environment", "entity", "qboId");
CREATE INDEX "QboEntityLink_entity_entityId_idx" ON "QboEntityLink"("entity", "entityId");

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
CREATE UNIQUE INDEX "QboTransaction_idempotencyKey_key" ON "QboTransaction"("idempotencyKey");
CREATE INDEX "QboTransaction_proposalId_proposalVersion_idx" ON "QboTransaction"("proposalId", "proposalVersion");
CREATE INDEX "QboTransaction_status_idx" ON "QboTransaction"("status");
CREATE INDEX "QboTransaction_type_idx" ON "QboTransaction"("type");
CREATE INDEX "QboTransaction_environment_idx" ON "QboTransaction"("environment");

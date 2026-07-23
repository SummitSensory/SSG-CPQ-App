CREATE TYPE "SyncState" AS ENUM ('LINKED','PENDING','ERROR','CONFLICT');

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
CREATE UNIQUE INDEX "ExternalLink_provider_entity_entityId_key" ON "ExternalLink"("provider", "entity", "entityId");
CREATE UNIQUE INDEX "ExternalLink_provider_externalId_key" ON "ExternalLink"("provider", "externalId");
CREATE INDEX "ExternalLink_entity_entityId_idx" ON "ExternalLink"("entity", "entityId");

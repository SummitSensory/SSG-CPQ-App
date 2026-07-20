-- Opportunity ↔ monday.com sync state
ALTER TABLE "Opportunity" ADD COLUMN "mondayItemId" TEXT;
ALTER TABLE "Opportunity" ADD COLUMN "mondaySyncHash" TEXT;
ALTER TABLE "Opportunity" ADD COLUMN "mondaySyncedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Opportunity_mondayItemId_key" ON "Opportunity"("mondayItemId");

CREATE TYPE "SyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');

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
CREATE UNIQUE INDEX "IntegrationSyncLog_eventId_key" ON "IntegrationSyncLog"("eventId");
CREATE INDEX "IntegrationSyncLog_entity_entityId_idx" ON "IntegrationSyncLog"("entity", "entityId");

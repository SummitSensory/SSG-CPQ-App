-- Expand Role enum from the foundation placeholder to the 11 milestone roles.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

CREATE TYPE "Role_new" AS ENUM (
  'SYSTEM_ADMIN','EXECUTIVE','SALES_REP','SALES_MANAGER','DESIGNER','ESTIMATOR',
  'OPERATIONS','ACCOUNTING','PROJECT_MANAGER','INSTALLER','READ_ONLY'
);

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "Role_new"
  USING (CASE "role"::text WHEN 'ADMIN' THEN 'SYSTEM_ADMIN' ELSE 'READ_ONLY' END::"Role_new");

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'READ_ONLY';

-- New User columns
ALTER TABLE "User" ADD COLUMN "name" TEXT;
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Session table (server-side session / refresh token handling)
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
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AuditLog table (append-only)
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetUserId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_targetUserId_idx" ON "AuditLog"("targetUserId");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

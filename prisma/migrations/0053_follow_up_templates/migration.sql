-- Follow-up email templates, editable in the app. Seeded from code on first read.

CREATE TABLE "FollowUpTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "whenToSend" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "caution" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FollowUpTemplate_key_key" ON "FollowUpTemplate"("key");
CREATE INDEX "FollowUpTemplate_active_step_idx" ON "FollowUpTemplate"("active", "step");

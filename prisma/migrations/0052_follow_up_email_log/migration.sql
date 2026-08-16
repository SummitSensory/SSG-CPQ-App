-- Proposal follow-up emails: which of the ten templates a customer has had.
-- Additive.

CREATE TABLE "FollowUpEmailLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "proposalId" TEXT,
    "templateKey" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "toName" TEXT,
    "toEmail" TEXT NOT NULL,
    "copiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentById" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "FollowUpEmailLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FollowUpEmailLog_organizationId_copiedAt_idx" ON "FollowUpEmailLog"("organizationId", "copiedAt");
CREATE INDEX "FollowUpEmailLog_organizationId_templateKey_idx" ON "FollowUpEmailLog"("organizationId", "templateKey");
CREATE INDEX "FollowUpEmailLog_proposalId_idx" ON "FollowUpEmailLog"("proposalId");

ALTER TABLE "FollowUpEmailLog"
  ADD CONSTRAINT "FollowUpEmailLog_organizationId_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Proposal e-signing (DocuSeal). Additive only: no existing table is touched.

CREATE TYPE "EsignStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOIDED', 'FAILED');
CREATE TYPE "EsignSignerStatus" AS ENUM ('PENDING', 'VIEWED', 'COMPLETED', 'DECLINED');
CREATE TYPE "EsignDocumentKind" AS ENUM ('PROPOSAL', 'ATTACHMENT');

CREATE TABLE "EsignDocumentTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "EsignDocumentKind" NOT NULL DEFAULT 'ATTACHMENT',
    "bodyHtml" TEXT NOT NULL,
    "productLineIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attachRule" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsignDocumentTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EsignDocumentTemplate_key_key" ON "EsignDocumentTemplate"("key");
CREATE INDEX "EsignDocumentTemplate_kind_active_idx" ON "EsignDocumentTemplate"("kind", "active");

CREATE TABLE "EsignEnvelope" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateKey" TEXT,
    "attachments" JSONB,
    "status" "EsignStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT,
    "message" TEXT,
    "docusealTemplateId" TEXT,
    "docusealSubmissionId" TEXT,
    "packageSha256" TEXT,
    "packageBytes" INTEGER,
    "packageUrl" TEXT,
    "signedUrl" TEXT,
    "error" TEXT,
    "declineReason" TEXT,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsignEnvelope_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EsignEnvelope_proposalId_idx" ON "EsignEnvelope"("proposalId");
CREATE INDEX "EsignEnvelope_versionId_idx" ON "EsignEnvelope"("versionId");
CREATE INDEX "EsignEnvelope_status_idx" ON "EsignEnvelope"("status");
CREATE INDEX "EsignEnvelope_docusealSubmissionId_idx" ON "EsignEnvelope"("docusealSubmissionId");

ALTER TABLE "EsignEnvelope"
  ADD CONSTRAINT "EsignEnvelope_templateId_fkey" FOREIGN KEY ("templateId")
  REFERENCES "EsignDocumentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EsignSigner" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 1,
    "status" "EsignSignerStatus" NOT NULL DEFAULT 'PENDING',
    "docusealSubmitterId" TEXT,
    "signingUrl" TEXT,
    "viewedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EsignSigner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EsignSigner_envelopeId_idx" ON "EsignSigner"("envelopeId");
CREATE INDEX "EsignSigner_docusealSubmitterId_idx" ON "EsignSigner"("docusealSubmitterId");
CREATE INDEX "EsignSigner_email_idx" ON "EsignSigner"("email");

ALTER TABLE "EsignSigner"
  ADD CONSTRAINT "EsignSigner_envelopeId_fkey" FOREIGN KEY ("envelopeId")
  REFERENCES "EsignEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EsignEvent" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EsignEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EsignEvent_envelopeId_payloadHash_key" ON "EsignEvent"("envelopeId", "payloadHash");
CREATE INDEX "EsignEvent_envelopeId_idx" ON "EsignEvent"("envelopeId");

ALTER TABLE "EsignEvent"
  ADD CONSTRAINT "EsignEvent_envelopeId_fkey" FOREIGN KEY ("envelopeId")
  REFERENCES "EsignEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

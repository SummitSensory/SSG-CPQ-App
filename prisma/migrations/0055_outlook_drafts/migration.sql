-- Outlook drafts via Microsoft Graph.
--
-- One row per rep who has consented to let the CRM write drafts into their own mailbox.
-- Tokens are stored encrypted by the application (AES-256-GCM, GRAPH_TOKEN_ENC_KEY), so
-- these columns hold ciphertext and are useless on their own.
CREATE TABLE IF NOT EXISTS "OutlookConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutlookConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OutlookConnection_userId_key" ON "OutlookConnection"("userId");

DO $$ BEGIN
  ALTER TABLE "OutlookConnection" ADD CONSTRAINT "OutlookConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The rep's own signature, appended to drafts this app creates. Graph cannot read the
-- one configured in Outlook, and OWA will not insert a signature into an existing draft.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailSignatureHtml" TEXT;

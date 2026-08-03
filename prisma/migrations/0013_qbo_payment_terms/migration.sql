-- Per-client and per-proposal QuickBooks payment terms, chosen in the portal.
-- Both nullable: absent means fall back (proposal -> organization -> default).
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "qboSalesTermId" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "qboSalesTermName" TEXT;
ALTER TABLE "Proposal" ADD COLUMN IF NOT EXISTS "qboSalesTermId" TEXT;
ALTER TABLE "Proposal" ADD COLUMN IF NOT EXISTS "qboSalesTermName" TEXT;

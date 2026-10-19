-- 0116_crm_list_sort_indexes
--
-- Three plain (non-unique) indexes on the columns the busiest lists sort by, so a
-- page of customers, opportunities or proposals is read in order instead of sorting
-- the whole table first: Organization.createdAt and Opportunity.createdAt (the CRM
-- screens' default sort, also used by the New proposal customer picker) and
-- Proposal.updatedAt (the Proposals list and the dashboard report). Additive only —
-- no data changes, and safe to run against production as it stands.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_createdAt_idx" ON "Opportunity"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Organization_createdAt_idx" ON "Organization"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Proposal_updatedAt_idx" ON "Proposal"("updatedAt");

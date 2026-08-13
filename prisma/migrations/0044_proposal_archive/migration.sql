-- Proposal archive: reversible removal from the pipeline.
--
-- Nothing is deleted. A proposal with archivedAt set drops out of the proposal list,
-- out of the pipeline and win-rate figures, and shows up only under the Archived tab
-- with its reason and who archived it. Clearing the three columns restores it exactly
-- as it was — statuses, versions, snapshots and any QuickBooks documents are all
-- untouched by this migration and by the archive action itself.

ALTER TABLE "Proposal"
  ADD COLUMN "archivedAt"    TIMESTAMP(3),
  ADD COLUMN "archivedById"  TEXT,
  ADD COLUMN "archiveReason" TEXT;

-- The list and the report both filter on "not archived", which is the vast majority of
-- rows, so the index is here for the Archived tab and for the reporting exclusion.
CREATE INDEX "Proposal_archivedAt_idx" ON "Proposal"("archivedAt");

-- Proposal.opportunityId: the deal a proposal is written for.
--
-- Nullable, and left null on every existing row: a proposal created before the picker
-- named no deal, and guessing one now would put an inference on record as a fact. The
-- accept path falls back to the customer's most recently updated linked deal and flags
-- that it did, so proposals that predate this keep working unchanged.
ALTER TABLE "Proposal" ADD COLUMN IF NOT EXISTS "opportunityId" TEXT;

CREATE INDEX IF NOT EXISTS "Proposal_opportunityId_idx" ON "Proposal"("opportunityId");

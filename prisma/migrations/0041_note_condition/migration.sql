-- Conditional standard notes.
--
-- A note may now carry a condition naming when it applies. NULL keeps the existing
-- behaviour (always), so every note already on the system is unaffected.
--
-- The case it exists for: two versions of the same paragraph, one that mentions the
-- deposit and one that does not. Unticking "show the deposit" on a proposal then
-- swaps the wording rather than leaving a note that contradicts the totals.
ALTER TABLE "StandardNote" ADD COLUMN "condition" TEXT;

-- Read on every proposal build, alongside the existing active/placement lookup.
CREATE INDEX "StandardNote_condition_idx" ON "StandardNote"("condition");

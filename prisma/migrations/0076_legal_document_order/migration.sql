-- Placement for contract documents: where each falls in the proposal, and whether it
-- prints at all.
--
-- Both default so existing rows need no backfill beyond the ordering below: a document
-- already in the table keeps printing, which is the safe reading of a column that did
-- not exist a minute ago.
ALTER TABLE "LegalDocument"
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;

-- Preserve the order these two have always printed in.
--
-- The release names the parties that the terms then rely on, so it goes first. With both
-- at the default 0 the tie would break on key, which is alphabetical — putting RELEASE
-- after TERMS and silently reversing a customer's document on the next deploy.
UPDATE "LegalDocument" SET "sortOrder" = 10 WHERE "key" = 'RELEASE';
UPDATE "LegalDocument" SET "sortOrder" = 20 WHERE "key" = 'TERMS';

-- Gaps of ten, so a document can be dropped between two existing ones without
-- renumbering the rest.
CREATE INDEX IF NOT EXISTS "LegalDocument_sortOrder_idx" ON "LegalDocument" ("sortOrder");

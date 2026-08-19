-- Outlined notes on the customer proposal.
--
-- Additive: every existing note keeps printing exactly as it does now.

ALTER TABLE "StandardNote" ADD COLUMN IF NOT EXISTS "emphasis" BOOLEAN NOT NULL DEFAULT false;

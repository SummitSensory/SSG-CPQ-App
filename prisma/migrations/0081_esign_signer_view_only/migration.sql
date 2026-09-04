-- 0081_esign_signer_view_only
--
-- Adds the CC/view-only flag to EsignSigner (see the model comment). A
-- non-nullable boolean with a default is safe to add to a live, populated
-- table — every existing row becomes `false` (a required signer), which is
-- what every row created before this feature existed actually was.

ALTER TABLE "EsignSigner" ADD COLUMN IF NOT EXISTS "viewOnly" BOOLEAN NOT NULL DEFAULT false;

-- 0074_user_address
--
-- A postal address on the user record, and a note about the signature column that
-- already exists beside it.
--
-- Why on the User and not in the Address table: Address rows belong to an
-- organization and carry a type (BILLING, SHIPPING) that a person does not have.
-- Six nullable columns here is a smaller thing than a nullable organizationId on
-- Address, which would weaken a constraint every customer-facing query relies on.
--
-- Every column is nullable with no default. An address nobody has filled in should
-- read as absent, not as an empty string that prints as a blank line on a letter.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "addressLine1" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "addressLine2" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city"         TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "region"       TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "postalCode"   TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country"      TEXT;

-- Percent-entry Canadian charges.
--
-- The full engine wants tax registrations, per-province rate rows, per-category
-- taxability rulings and a broker fee schedule before it will quote anything. That is
-- the right long-term shape and it is why no Canadian proposal can currently be
-- released: the answers have a lead time nobody controls.
--
-- Simple mode is the interim. The operator types the tax rate, the tariff rate and the
-- broker's fee, and the arithmetic is done from those. It is not a tariff calculator
-- and does not pretend to be one — there are no HS codes, no origin records and no
-- CUSMA determination behind these figures, which is exactly what the proposal says.
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "simpleMode" BOOLEAN NOT NULL DEFAULT false;
-- What the tax is called on this job: HST, GST + PST, GST + QST. Printed verbatim.
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "taxLabel" TEXT;
-- Basis points, so 13% is 1300 and Quebec's 9.975% is 997.5 -> stored as 998? No:
-- stored to three decimal places as an integer of thousandths of a percent, so
-- 9.975% is 9975 and 13% is 13000. Integer arithmetic, no float drift.
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "taxPercentMilli" INTEGER;
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "tariffPercentMilli" INTEGER;
-- Whether the tariff applies to freight as well as goods. Off by default: duty is
-- assessed on the customs value of the goods.
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "tariffOnFreight" BOOLEAN NOT NULL DEFAULT false;
-- Whether tax applies on top of the tariff and the brokerage. On by default, which is
-- how GST/HST works on an import.
ALTER TABLE "ProposalCustomsEntry" ADD COLUMN "taxOnDuty" BOOLEAN NOT NULL DEFAULT true;

-- Rollback
-- ALTER TABLE "ProposalCustomsEntry" DROP COLUMN "simpleMode", DROP COLUMN "taxLabel", DROP COLUMN "taxPercentMilli", DROP COLUMN "tariffPercentMilli", DROP COLUMN "tariffOnFreight", DROP COLUMN "taxOnDuty";

-- The switch that permits percent entry at all. Off by default: turning it on is a
-- decision to quote from stated rates rather than from rulings.
ALTER TABLE "CrossBorderSetting" ADD COLUMN "allowSimpleCanadianCharges" BOOLEAN NOT NULL DEFAULT false;

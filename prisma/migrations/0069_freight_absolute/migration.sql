-- A freight amount that states the bucket's whole figure.
--
-- Job-level amounts were always ADDED to whatever the proposal already carried, on the
-- reasoning that freight arrives in instalments. That is right for a genuine second
-- shipment and wrong for the common case: the deal board states a total, the proposal
-- already carries that total, and applying it again doubles the figure on a signed
-- document. There was also no way back — Remove only exists while an entry is staged.
--
-- With this flag an amount can say which it is, so a wrong total can be corrected by
-- stating the right one.
ALTER TABLE "FreightEntry" ADD COLUMN "absolute" BOOLEAN NOT NULL DEFAULT false;

-- Rollback
-- ALTER TABLE "FreightEntry" DROP COLUMN "absolute";

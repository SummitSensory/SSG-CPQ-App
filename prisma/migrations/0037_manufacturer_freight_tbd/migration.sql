-- Vendors whose freight is quoted after the fact.
--
-- A part sourced from one of these carries a standing note on its proposal line
-- ("shipping and freight charges have not yet been determined…") until a freight
-- figure is entered on that line, at which point the note is no longer shown.
-- The flag lives on the vendor rather than the part because it is a property of how
-- that vendor prices delivery, not of any one item.
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "freightTbd" BOOLEAN NOT NULL DEFAULT false;

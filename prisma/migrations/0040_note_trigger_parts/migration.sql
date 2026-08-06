-- Part-triggered proposal notes.
--
-- Comma-separated part numbers on a standard note. When any of them is on a
-- proposal the note is added once, at the end of the section that part sits in.
-- Nullable with no backfill: existing notes keep behaving exactly as they do,
-- either always-included or picked by hand.

ALTER TABLE "StandardNote" ADD COLUMN "triggerParts" TEXT;

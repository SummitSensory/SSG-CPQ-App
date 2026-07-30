-- 0030_requirement_task_updated_by
--
-- Who last changed a requirement or an internal task. The order page shows the
-- status, the person and the date in one column; before this, a status told you
-- what state something was in but never who put it there.
--
-- Nullable on purpose: rows that predate this migration genuinely have no
-- recorded author, and inventing one would be worse than showing "—".

ALTER TABLE "HandoffRequirement" ADD COLUMN "updatedById" TEXT;
ALTER TABLE "HandoffTask" ADD COLUMN "updatedById" TEXT;

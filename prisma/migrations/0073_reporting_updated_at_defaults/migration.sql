-- 0073_reporting_updated_at_defaults
--
-- Drop the database default on the two reporting tables' "updatedAt" columns.
--
-- 0072 created them as `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`, copying the
-- house pattern from earlier migrations. Prisma's `@updatedAt` is application-managed:
-- the client writes the timestamp on every update, and the datamodel therefore
-- declares no default. The database having one is harmless at runtime but it is
-- permanent drift — `pnpm db:drift` reports it on every run, and a drift check that
-- always says something is a drift check nobody reads.
--
-- 0072 is already recorded as applied, so it cannot be edited: Prisma stores a
-- checksum per migration and refuses to deploy once one changes. Hence a second
-- migration rather than a correction to the first.
--
-- Guarded via a catalog check so a re-run is harmless.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'SavedReport'
       AND column_name = 'updatedAt'
       AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE "SavedReport" ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'SalesGoal'
       AND column_name = 'updatedAt'
       AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE "SalesGoal" ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;
END $$;

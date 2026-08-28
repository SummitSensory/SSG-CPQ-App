# Database migrations

## Why `prisma migrate dev` does not work here

It fails:

```
Error: P3006
Migration `0001_init` failed to apply cleanly to the shadow database.
ERROR: type "Role" already exists
```

`migrate dev` creates a throwaway shadow database and replays every migration from
the beginning to work out what changed. Our history cannot be replayed: `0000_baseline`
creates the whole schema as it stood at the time, and `0001_init` through roughly
`0013_*` then create some of the same types and tables again. Applied once, in order,
against a real database, that was fine. Replayed from empty, the second `CREATE TYPE
"Role"` fails.

This is why every migration from about `0029` onward is hand-written, guarded SQL
rather than Prisma's generated output.

**Do not try to fix this by editing an old migration.** Prisma stores a checksum for
every applied migration in the `_prisma_migrations` table. Change the file and
`migrate deploy` refuses to run, in production, during a build.

## How to make a schema change

```powershell
# 1. Edit prisma/schema.prisma as normal.

# 2. Generate the migration from the difference between the database and the schema.
pnpm db:new customer_tags --guard

# 3. Read the SQL it wrote. Write the header sentence explaining the change.
#    Guard anything the generator flagged as NOT GUARDED.

# 4. Apply it, record it, regenerate the client, and confirm no drift remains.
npx prisma db execute --file prisma/migrations/0073_customer_tags/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 0073_customer_tags
npx prisma generate
pnpm db:drift
```

Step 4's last command must report `drift: none`. If it does not, the migration did not
produce what `schema.prisma` describes — fix the SQL and re-run before committing.

Production needs nothing extra: the committed migration folder is what
`scripts/migrate-deploy.mjs` applies during the Vercel build.

### Why guarded SQL

`migrate-deploy.mjs` runs on every deploy. A migration that half-applied — a network
drop between two statements — must be repairable by running it again. So:

```sql
CREATE TABLE IF NOT EXISTS "Thing" ( … );
CREATE INDEX IF NOT EXISTS "Thing_x_idx" ON "Thing"("x");
ALTER TABLE "Thing" ADD COLUMN IF NOT EXISTS "y" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ThingKind') THEN
    CREATE TYPE "ThingKind" AS ENUM ('A', 'B');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Thing_otherId_fkey') THEN
    ALTER TABLE "Thing" ADD CONSTRAINT "Thing_otherId_fkey" FOREIGN KEY ("otherId")
      REFERENCES "Other"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
```

`pnpm db:new --guard` writes the first three shapes for you and comments anything it
did not recognise.

## Drift

`pnpm db:drift` asks Prisma to diff the live database against `schema.prisma` and
prints the SQL that would reconcile them. Empty means they agree.

It runs in three places:

| Where                          | Behaviour                                             |
| ------------------------------ | ----------------------------------------------------- |
| `pnpm db:drift`                | Fails on drift, prints the SQL                        |
| `pnpm check`                   | Fails on drift                                        |
| Vercel build, after migrations | **Warns** and prints the SQL; does not fail the build |

The build only warns on purpose. By that point the migrations it was given have
applied successfully, and blocking a release over a diff that might be a deliberate
manual change trades a small problem for a bigger one. But drift that nobody is told
about survives for weeks, which is how a column declared in `schema.prisma` and absent
from the database becomes a 500 on a screen nobody was testing.

It is not in the pre-push hook, for the reason the hook itself gives: a push should not
fail because a laptop is offline.

## Optional: squashing the history

Not required, and not urgent. It would let `migrate dev` work again, at the cost of one
carefully executed operation against production's `_prisma_migrations` table. Do it on
a quiet afternoon with a database branch to test on, never on a Friday.

```powershell
# 0. Take a Neon branch of production and point DIRECT_URL at it. Rehearse there first.

# 1. Generate one migration that builds the whole schema from empty.
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > squashed.sql

# 2. Create prisma/migrations/0000_squashed/migration.sql from it.
#    Move every existing migration folder to prisma/migrations-archive/ (keep them in
#    git — they are the record of how the schema got here).

# 3. On the rehearsal branch, tell Prisma the squashed migration is already applied:
npx prisma migrate resolve --applied 0000_squashed

# 4. Remove the now-orphaned rows so `migrate status` is clean:
#    DELETE FROM "_prisma_migrations" WHERE migration_name <> '0000_squashed';

# 5. Verify on the rehearsal branch:
npx prisma migrate status     # expect: database schema is up to date
pnpm db:drift                 # expect: drift: none
npx prisma migrate dev --name throwaway --create-only   # expect: it WORKS now

# 6. Only then repeat steps 3–4 against production, and deploy.
```

Two things that make this safe to defer: nothing about the current history is broken
for `migrate deploy`, which is what production uses, and `pnpm db:new` plus
`pnpm db:drift` remove the day-to-day hazard without touching history at all.

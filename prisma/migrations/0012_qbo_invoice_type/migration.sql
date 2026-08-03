-- Full-value itemized invoice type. Adding an enum value cannot run inside a
-- transaction block on older Postgres, so it stands alone as its own migration.
ALTER TYPE "QboTxnType" ADD VALUE IF NOT EXISTS 'INVOICE';

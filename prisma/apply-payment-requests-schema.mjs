#!/usr/bin/env node
/**
 * Fold the payment-request models into prisma/schema.prisma.
 *
 * Same job as apply-crossborder-schema.mjs and apply-admin-ops-schema.mjs: the
 * models are authored in a fragment file so they can be reviewed on their own, and
 * this puts them into the real schema without anyone hand-editing 3,600 lines at
 * eight in the evening.
 *
 * Two edits, both idempotent — run it twice and the second run reports "already
 * applied" and changes nothing:
 *
 *   1. Six columns into `model QboTransaction`, inserted after qboLastSyncedAt,
 *      which is the last of the QuickBooks-mirrored fields and therefore where
 *      they belong.
 *   2. The enum and three models appended to the end of the file.
 *
 * A backup is written next to the schema before anything is changed. Run
 * `npx prisma validate` afterwards; if it complains, restore the backup and tell
 * me what it said.
 *
 *   node prisma/apply-payment-requests-schema.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, 'schema.prisma');
const fragmentPath = join(here, 'schema.payment-requests.prisma');

if (!existsSync(schemaPath)) {
  console.error(`Cannot find ${schemaPath}. Run this from the repo, not from a copy.`);
  process.exit(1);
}
if (!existsSync(fragmentPath)) {
  console.error(
    `Cannot find ${fragmentPath}. Copy prisma/schema.payment-requests.prisma in first.`,
  );
  process.exit(1);
}

let schema = readFileSync(schemaPath, 'utf8');
const fragment = readFileSync(fragmentPath, 'utf8');
const original = schema;

/** Whether the schema already carries something, so a re-run is harmless. */
const has = (needle) => schema.includes(needle);

/* ------------------------------------------------------- 1. QboTransaction columns */

const COLUMNS = `  qboLastSyncedAt   DateTime?

  /// The invoice total as QuickBooks FIRST reported it, never overwritten.
  /// qboTotalMinor tracks the current total and moves when accounting edits the
  /// document; this is what the customer was originally billed, which is the figure
  /// "initial invoice balance" means.
  initialTotalMinor BigInt?
  /// QuickBooks' TxnDate — the invoice date as it prints on the document.
  invoiceDate       DateTime?
  /// Intuit's shareable payment link, when the company has online payment switched
  /// on. Null is normal and the merge field then renders nothing rather than a
  /// broken link.
  qboInvoiceLink    String?
  /// The PO number as last written onto the QuickBooks document, and when.
  poPushedValue     String?
  poPushedAt        DateTime?
  /// Set when the PO on the order no longer matches poPushedValue. Drives the
  /// "push to QuickBooks" action on the receivables screen.
  poNeedsPush       Boolean   @default(false)`;

if (has('initialTotalMinor')) {
  console.log('· QboTransaction columns: already applied');
} else {
  // Anchored on the exact declaration rather than a line number or a brace count:
  // qboLastSyncedAt appears once in the file, and if it ever stops appearing this
  // should fail loudly rather than write the columns into some other model.
  const anchor = '  qboLastSyncedAt   DateTime?';
  const at = schema.indexOf(anchor);
  if (at === -1) {
    console.error(
      'Could not find the qboLastSyncedAt field in model QboTransaction, so the six\n' +
        'columns were NOT added. The schema has changed shape — add them by hand from\n' +
        'the list at the bottom of prisma/schema.payment-requests.prisma.',
    );
    process.exit(1);
  }
  if (schema.indexOf(anchor, at + 1) !== -1) {
    console.error('qboLastSyncedAt appears more than once. Refusing to guess which one.');
    process.exit(1);
  }
  schema = schema.slice(0, at) + COLUMNS + schema.slice(at + anchor.length);
  console.log('· QboTransaction columns: added');
}

/* ---------------------------------------------------------------- 2. the models */

if (has('model PaymentRequestEmail')) {
  console.log(
    '· PaymentTemplate / CustomerPurchaseOrderFile / PaymentRequestEmail: already present',
  );
} else {
  const body = fragment.trimEnd();
  schema = `${schema.trimEnd()}\n\n${body}\n`;
  console.log('· Models appended: PaymentTemplate, CustomerPurchaseOrderFile, PaymentRequestEmail');
}

/* ------------------------------------------------------------------------ write */

if (schema === original) {
  console.log('\nNothing to do — the schema already has everything.');
  process.exit(0);
}

const backup = `${schemaPath}.before-payment-requests.bak`;
writeFileSync(backup, original, 'utf8');
writeFileSync(schemaPath, schema, 'utf8');

console.log(`\nSchema updated. Backup written to ${backup}`);
console.log('Next:  npx prisma validate  &&  npx prisma generate');

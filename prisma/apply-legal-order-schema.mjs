#!/usr/bin/env node
/**
 * Add `sortOrder` and `enabled` to `model LegalDocument`.
 *
 * Same job as apply-payment-requests-schema.mjs: the change is applied to
 * prisma/schema.prisma by a script rather than by hand-editing 4,000 lines.
 *
 * WHY THESE TWO COLUMNS AND NOT THE CONTENT JSON
 * ----------------------------------------------
 * Both could have been stored inside `content`, which needs no migration at all. They
 * are not, and the reason matters: `content` is the legal wording, and every publish of
 * it writes an append-only row to `LegalDocumentRevision` so a released proposal can be
 * explained years later. Putting placement in there would mean dragging a document up
 * the list creates a new published revision of text nobody edited — and the revision
 * history, which exists to answer "what did this say when they signed it", would fill
 * with entries that changed no words.
 *
 * Order and whether a document prints are facts about the document's placement, not
 * about its wording. They belong in columns.
 *
 * Idempotent — run it twice and the second run reports "already applied". A backup is
 * written next to the schema first. Run `npx prisma validate` afterwards.
 *
 *   node prisma/apply-legal-order-schema.mjs
 *   npx prisma validate
 *   npx prisma db execute --file prisma/migrations/0076_legal_document_order/migration.sql --schema prisma/schema.prisma
 *   npx prisma generate
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, 'schema.prisma');

if (!existsSync(schemaPath)) {
  console.error(`Cannot find ${schemaPath}. Run this from the repo, not from a copy.`);
  process.exit(1);
}

let schema = readFileSync(schemaPath, 'utf8');
const original = schema;

/*
 * The file's own line endings, and why this script cares.
 *
 * The first version of this matched a multi-line anchor written with \n against a file
 * checked out on Windows with CRLF. It never matched, and the script reported that the
 * model had been edited — which was not true, and sent the reader looking for a change
 * nobody had made. The refusal was right in form and wrong in substance, which is the
 * more annoying kind of wrong.
 *
 * Everything below is matched against a \n-normalised copy and written back in the file's
 * own convention, so a CRLF checkout is neither misread nor silently converted.
 */
const CRLF = schema.includes('\r\n');
const nl = (text) => (CRLF ? text.replace(/\n/g, '\r\n') : text);
const normalised = schema.replace(/\r\n/g, '\n');

const ANCHOR = `model LegalDocument {
  key            String    @id
  title          String
  content        Json`;

const REPLACEMENT = `model LegalDocument {
  key            String    @id
  title          String
  /// Where this document falls in the proposal, low to high. Ties break on key so the
  /// order is stable rather than whatever the database happens to return.
  sortOrder      Int       @default(0)
  /// Whether it prints at all. Disabling is how a document is retired: the wording and
  /// its revision history stay, so a proposal released under it can still be explained.
  enabled        Boolean   @default(true)
  content        Json`;

if (normalised.includes('sortOrder      Int       @default(0)')) {
  console.log('Already applied — schema.prisma already has sortOrder and enabled.');
  process.exit(0);
}

if (!normalised.includes(ANCHOR)) {
  console.error(
    'Could not find `model LegalDocument` with the expected first three fields.\n' +
      'The model has been edited since this script was written. Add these two fields by\n' +
      'hand, after `title`:\n\n' +
      '  sortOrder      Int       @default(0)\n' +
      '  enabled        Boolean   @default(true)\n',
  );
  process.exit(1);
}

schema = schema.replace(nl(ANCHOR), nl(REPLACEMENT));

if (schema === original) {
  console.error('Nothing changed. Refusing to write an identical file.');
  process.exit(1);
}

const backupPath = schemaPath + '.before-legal-order';
writeFileSync(backupPath, original, 'utf8');
writeFileSync(schemaPath, schema, 'utf8');

console.log('');
console.log('Added to model LegalDocument:');
console.log('   sortOrder  Int      @default(0)');
console.log('   enabled    Boolean  @default(true)');
console.log('');
console.log(`Backup: ${backupPath}`);
console.log('');
console.log('Next:');
console.log('   npx prisma validate');
console.log(
  '   npx prisma db execute --file prisma/migrations/0076_legal_document_order/migration.sql --schema prisma/schema.prisma',
);
console.log('   npx prisma generate');
console.log('');

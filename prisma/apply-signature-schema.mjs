#!/usr/bin/env node
/**
 * Add the handwritten-signature column to `model User`.
 *
 * Same job and same shape as apply-payment-requests-schema.mjs: one column, added
 * by anchor rather than by line number, idempotent, with a backup written first.
 *
 * Why a column and not a file in blob storage: renderPdf has no network. An <img
 * src> pointing at the app prints a broken image on a document a customer receives,
 * so the signature has to be inlined into the letter HTML as a data URI at render
 * time. Keeping it as a data URI on the row means the letter renderer needs one
 * query and no fetch. The write path caps it at 400 KB, which is far more than a
 * 90px-wide signature needs.
 *
 *   node prisma/apply-signature-schema.mjs
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

const original = readFileSync(schemaPath, 'utf8');
let schema = original;

const COLUMN = `  emailSignatureHtml String?

  /// The rep's handwritten signature, as a PNG/JPEG data URI, printed above the
  /// sender block on every letter this app generates.
  ///
  /// A data URI rather than a URL because renderPdf has no network: an <img src>
  /// pointing at the app would print a broken image on a document a customer
  /// receives. Null is normal and the letter then leaves the signature space blank
  /// rather than filling it with somebody else's name.
  signatureImage     String?`;

if (schema.includes('signatureImage')) {
  console.log('· User.signatureImage: already applied');
} else {
  // Anchored on the exact declaration. emailSignatureHtml appears once, and if it
  // ever stops appearing this should fail loudly rather than write the column into
  // some other model.
  const anchor = '  emailSignatureHtml String?';
  const at = schema.indexOf(anchor);
  if (at === -1) {
    console.error(
      'Could not find emailSignatureHtml in model User, so signatureImage was NOT\n' +
        'added. Add it by hand:  signatureImage String?  inside model User.',
    );
    process.exit(1);
  }
  if (schema.indexOf(anchor, at + 1) !== -1) {
    console.error('emailSignatureHtml appears more than once. Refusing to guess which one.');
    process.exit(1);
  }
  schema = schema.slice(0, at) + COLUMN + schema.slice(at + anchor.length);
  console.log('· User.signatureImage: added');
}

if (schema === original) {
  console.log('\nNothing to do — the schema already has it.');
  process.exit(0);
}

const backup = `${schemaPath}.before-signature.bak`;
writeFileSync(backup, original, 'utf8');
writeFileSync(schemaPath, schema, 'utf8');

console.log(`\nSchema updated. Backup written to ${backup}`);
console.log('Next:  npx prisma validate  &&  npx prisma generate  &&  npx prisma db push');

/**
 * Fixes the misplaced `freightTrueUps` relation field and finishes wiring the
 * freight true-up models into prisma/schema.prisma.
 *
 * Run from the repo root:  node prisma/fix-freight-trueup-schema.mjs
 * Then:                    pnpm db:generate
 *
 * The first version of this script anchored on `freightRfqs FreightRfq[]`, which
 * appears in BOTH model Manufacturer and model Proposal — and Manufacturer comes
 * first in the file, so the relation field landed on the wrong model. This one
 * works on the text of the `model Proposal { … }` block only, so there is nothing
 * to match by accident.
 *
 * Idempotent. Writes prisma/schema.prisma.bak2 before saving.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PATH = 'prisma/schema.prisma';
const FIELD = 'freightTrueUps FreightTrueUp[]';

if (!existsSync(PATH)) {
  console.error(`Cannot find ${PATH}. Run this from the repository root.`);
  process.exit(1);
}

const before = readFileSync(PATH, 'utf8');
let schema = before;

// ---- 1. take the field off every model, wherever the first run put it.
const stray = new RegExp(`^[ \\t]*${FIELD.replace(/[[\]]/g, '\\$&')}[ \\t]*\\r?\\n`, 'gm');
const removed = (schema.match(stray) ?? []).length;
schema = schema.replace(stray, '');
if (removed) console.log(`Removed ${removed} misplaced \`${FIELD}\` line(s).`);

// ---- 2. put it inside model Proposal, and only there.
const block = /model Proposal \{[\s\S]*?\n\}/;
const found = block.exec(schema);
if (!found) {
  console.error('Could not locate `model Proposal { … }`. Nothing written.');
  process.exit(1);
}
let proposal = found[0];

if (proposal.includes(FIELD)) {
  console.log('model Proposal already carries the field.');
} else {
  // After its own freightRfqs line if there is one, otherwise before the closing brace.
  const anchor = /^([ \t]*freightRfqs\s+FreightRfq\[\].*)$/m;
  proposal = anchor.test(proposal)
    ? proposal.replace(anchor, `$1\n  ${FIELD}`)
    : proposal.replace(/\n\}$/, `\n  ${FIELD}\n}`);
  schema = schema.slice(0, found.index) + proposal + schema.slice(found.index + found[0].length);
  console.log('Inserted the field into model Proposal.');
}

if (!schema.includes('model FreightTrueUp')) {
  console.error(
    'model FreightTrueUp is missing from the schema — run prisma/apply-freight-trueup-schema.mjs first (it appends it).',
  );
  process.exit(1);
}

// ---- 3. sanity check: exactly one relation field, on the right model.
const occurrences = (schema.match(new RegExp(FIELD.replace(/[[\]]/g, '\\$&'), 'g')) ?? []).length;
const inProposal = block.exec(schema)?.[0].includes(FIELD);
if (occurrences !== 1 || !inProposal) {
  console.error(
    `Refusing to write: found ${occurrences} copies of the field, in Proposal: ${inProposal}. Restore prisma/schema.prisma.bak and add the line by hand.`,
  );
  process.exit(1);
}

if (schema === before) {
  console.log('Schema already correct.');
  process.exit(0);
}

writeFileSync(`${PATH}.bak2`, before, 'utf8');
writeFileSync(PATH, schema, 'utf8');
console.log(`Wrote ${PATH} (previous version saved as ${PATH}.bak2). Now run: pnpm db:generate`);

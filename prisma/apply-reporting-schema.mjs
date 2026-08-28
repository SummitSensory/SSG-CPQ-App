#!/usr/bin/env node
/**
 * Fold the reporting and goals models into prisma/schema.prisma.
 *
 * Same job as apply-payment-requests-schema.mjs: the models are authored in a
 * fragment so they can be read on their own, and this appends them to the real
 * schema without anyone hand-editing 3,800 lines.
 *
 * Idempotent — run it twice and the second run reports "already applied" and
 * changes nothing. Nothing existing is modified: this only appends, because the
 * two models stand alone and no current model needs a column for them.
 *
 * A backup is written next to the schema first.
 *
 *   node prisma/apply-reporting-schema.mjs
 *   npx prisma validate && npx prisma generate && npx prisma db push
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, 'schema.prisma');
const fragmentPath = join(here, 'schema.reporting.prisma');

if (!existsSync(schemaPath)) {
  console.error(`Cannot find ${schemaPath}. Run this from the repo, not from a copy.`);
  process.exit(1);
}
if (!existsSync(fragmentPath)) {
  console.error(`Cannot find ${fragmentPath}. Copy prisma/schema.reporting.prisma in first.`);
  process.exit(1);
}

const original = readFileSync(schemaPath, 'utf8');
const fragment = readFileSync(fragmentPath, 'utf8');

if (original.includes('model SavedReport') && original.includes('model SalesGoal')) {
  console.log('· SavedReport / SalesGoal: already applied');
  console.log('\nNothing to do — the schema already has everything.');
  process.exit(0);
}
if (original.includes('model SavedReport') || original.includes('model SalesGoal')) {
  console.error(
    'The schema has one of the two models but not the other. Refusing to guess:\n' +
      'add the missing model by hand from prisma/schema.reporting.prisma.',
  );
  process.exit(1);
}
// The enums are appended with the models, so a name already in use would be a
// silent duplicate at validate time. Caught here, where the message can say why.
for (const name of ['enum ReportCadence', 'enum GoalMetric', 'enum GoalPeriod']) {
  if (original.includes(name)) {
    console.error(`${name} already exists in the schema. Rename it in the fragment first.`);
    process.exit(1);
  }
}

// Only the model and enum declarations are wanted — the fragment's header comment
// explains the file to a reader, not the schema.
const body = fragment
  .split('\n')
  .slice(
    fragment.split('\n').findIndex((l) => /^(model|enum|\/\/\/)/.test(l.trim()) && l.trim() !== ''),
  )
  .join('\n')
  .trimEnd();

const schema = `${original.trimEnd()}\n\n${body}\n`;

const backup = `${schemaPath}.before-reporting.bak`;
writeFileSync(backup, original, 'utf8');
writeFileSync(schemaPath, schema, 'utf8');

console.log('· Enums appended: ReportCadence, GoalMetric, GoalPeriod');
console.log('· Models appended: SavedReport, SalesGoal');
console.log(`\nSchema updated. Backup written to ${backup}`);
console.log('Next:  npx prisma validate && npx prisma generate && npx prisma db push');

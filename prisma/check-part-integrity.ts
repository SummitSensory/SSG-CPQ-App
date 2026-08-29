/**
 * Catalog integrity, on demand.
 *
 * Wraps `src/catalog/partIntegrity.ts` and exits non-zero when a BLOCKING violation is
 * present, so it can sit in `pnpm check` alongside the typecheck and the migration status
 * and fail a release the same way they do.
 *
 * Warnings do not fail. A check that blocks on everything gets switched off, and the
 * warning cases (a priced record with no catalog record, a category label out of step)
 * cannot put a wrong number on a customer document.
 *
 *   npx tsx --env-file=.env prisma/check-part-integrity.ts
 *   npx tsx --env-file=.env prisma/check-part-integrity.ts --strict   # warnings fail too
 */
import { PrismaClient } from '@prisma/client';
import { checkPartIntegrity, formatIntegrityReport } from '../src/catalog/partIntegrity.js';

const prisma = new PrismaClient();
const STRICT = process.argv.includes('--strict');

async function main() {
  const report = await checkPartIntegrity(prisma);
  console.log('');
  console.log('CATALOG INTEGRITY');
  console.log('='.repeat(78));
  console.log(formatIntegrityReport(report));
  console.log('='.repeat(78));

  const failed = STRICT ? report.violations.length : report.blocking;
  if (!failed) {
    console.log(
      report.warnings
        ? `Pass. ${report.warnings} warning(s) — not blocking; run with --strict to treat them as failures.`
        : 'Pass.',
    );
    console.log('');
    return;
  }

  console.log(`FAIL — ${failed} ${STRICT ? 'violation(s)' : 'blocking violation(s)'}.`);
  console.log('');
  console.log('Repairs, where the right answer is knowable:');
  console.log('   product-without-sku  -> prisma/repair-half-created-parts.ts');
  console.log('   vendor-disagreement  -> prisma/align-vendor-sourcing.ts');
  console.log('');
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

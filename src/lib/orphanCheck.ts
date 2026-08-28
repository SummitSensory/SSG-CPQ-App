/**
 * Orphaned references.
 *
 * Several \`*ById\` columns in this schema are deliberately NOT foreign keys. The
 * migrations say why, each time: "NOT a foreign key — a deleted or rejected proposal
 * must leave its notes behind", and the same reasoning for a deactivated user who must
 * not take a customer note, a saved report or a sales target with them.
 *
 * That is a defensible trade, and it has a cost nobody was paying attention to: the
 * ids accumulate, and every read that resolves one through a lookup can miss. The
 * result is display-only — a "—" where a name should be — but it is invisible until
 * somebody notices a blank on a screen and cannot explain it.
 *
 * So: count them. Not repair them, and not constrain them. Counting is the whole
 * point — an orphan that is known about is a decision, and one that is not is a
 * mystery in six months.
 *
 * Raw SQL rather than Prisma relations, because the relations do not exist. That is
 * the condition being measured.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface OrphanCount {
  /** Table.column that holds the dangling id. */
  reference: string;
  /** What it should have pointed at. */
  expected: string;
  count: number;
  /** Up to five examples, for tracing one down. */
  samples: string[];
}

export interface OrphanReport {
  ok: boolean;
  total: number;
  orphans: OrphanCount[];
  checkedAt: string;
  error?: string;
}

/**
 * The references worth checking.
 *
 * Only user references, and only where a name is displayed. A dangling
 * \`archivedById\` matters because the archive dialog names who archived it; a
 * dangling id on a column nobody renders is noise in a report meant to be read.
 *
 * Deliberately a list rather than something derived from the schema: derivation would
 * pick up every id column including the ones that ARE foreign keys and cannot dangle,
 * and the report would then be mostly zeroes.
 */
const CHECKS: Array<{ table: string; column: string; expected: string }> = [
  { table: 'Proposal', column: 'createdById', expected: 'User' },
  { table: 'Proposal', column: 'archivedById', expected: 'User' },
  { table: 'AcceptedOrder', column: 'acceptedById', expected: 'User' },
  { table: 'CustomerNote', column: 'authorId', expected: 'User' },
  { table: 'SavedReport', column: 'createdById', expected: 'User' },
  { table: 'SavedReport', column: 'sendAsId', expected: 'User' },
  { table: 'SalesGoal', column: 'createdById', expected: 'User' },
  { table: 'SalesGoal', column: 'ownerId', expected: 'User' },
  { table: 'ProcurementLine', column: 'invoicedById', expected: 'User' },
];

/**
 * Count dangling ids.
 *
 * Each check is its own query and its own try/catch: a table that does not exist yet
 * on this deployment (a migration not applied, a model added later) should report as
 * skipped rather than failing the whole report. That is the difference between a
 * diagnostic that stays useful and one that is switched off after it cries wolf.
 */
export async function checkOrphanedReferences(): Promise<OrphanReport> {
  const orphans: OrphanCount[] = [];
  let hardError: string | undefined;

  for (const check of CHECKS) {
    const reference = `${check.table}.${check.column}`;
    try {
      // Identifiers are from the constant list above, never from input.
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; ref: string }>>(
        `SELECT t."id" AS id, t."${check.column}" AS ref
           FROM "${check.table}" t
      LEFT JOIN "${check.expected}" u ON u."id" = t."${check.column}"
          WHERE t."${check.column}" IS NOT NULL
            AND u."id" IS NULL
          LIMIT 500`,
      );
      if (rows.length) {
        orphans.push({
          reference,
          expected: check.expected,
          count: rows.length,
          samples: rows.slice(0, 5).map((r) => `${r.id} → ${r.ref}`),
        });
      }
    } catch (err) {
      // A missing table is expected on a deployment behind this code. Anything else
      // is worth knowing about, but not worth failing the report over.
      const message = err instanceof Error ? err.message : String(err);
      if (!/does not exist|relation .* does not exist/i.test(message)) {
        logger.warn({ err, reference }, 'orphan check failed');
        hardError = hardError ?? message;
      }
    }
  }

  const total = orphans.reduce((a, b) => a + b.count, 0);
  return {
    ok: total === 0 && !hardError,
    total,
    orphans,
    checkedAt: new Date().toISOString(),
    ...(hardError ? { error: hardError } : {}),
  };
}

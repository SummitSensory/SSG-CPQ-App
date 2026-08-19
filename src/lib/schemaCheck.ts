import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendAlert } from '../lib/alerts.js';

/**
 * Is the database actually shaped the way the deployed code thinks it is?
 *
 * This exists because of a specific outage. Migration 0057 added
 * `AcceptedOrder.portalOrderItemId`; the code deployed and the migration did not
 * run. Prisma selects every column its client knows about, so a single missing
 * column broke every `acceptedOrder` query in the application — the orders list
 * included, which has nothing to do with the feature that added it. The 500s went
 * to the log and nowhere else.
 *
 * `prisma migrate deploy` now runs in the Vercel build, which stops it happening
 * again. This is the belt to that braces: it costs one cheap query, it names the
 * problem in words instead of a `P2022` stack trace, and it catches the case the
 * build command cannot — a migration applied to the wrong database, or a manual
 * change to production.
 *
 * Read-only, and it never throws. A failed check must not stop the server booting;
 * a CRM that serves most screens correctly is better than one that refuses to start.
 */

/** Columns the deployed code cannot function without, added by recent migrations. */
const REQUIRED_COLUMNS: Array<{ table: string; column: string; since: string }> = [
  { table: 'AcceptedOrder', column: 'portalOrderItemId', since: '0057_portal_delivery' },
  { table: 'BomVendorSection', column: 'loadingDock', since: '0057_portal_delivery' },
  { table: 'ShipToAddress', column: 'source', since: '0057_portal_delivery' },
  { table: 'FreightRfq', column: 'shipToSource', since: '0057_portal_delivery' },
];

/** Tables recent migrations created. A missing one breaks its whole feature. */
const REQUIRED_TABLES: Array<{ table: string; since: string }> = [
  { table: 'PortalDeliverySubmission', since: '0057_portal_delivery' },
  { table: 'PortalColorSelection', since: '0057_portal_delivery' },
];

export interface SchemaDriftReport {
  ok: boolean;
  missingColumns: Array<{ table: string; column: string; since: string }>;
  missingTables: Array<{ table: string; since: string }>;
  /** The check itself failed — says nothing about the schema either way. */
  error: string | null;
}

export async function checkSchemaDrift(): Promise<SchemaDriftReport> {
  const report: SchemaDriftReport = {
    ok: true,
    missingColumns: [],
    missingTables: [],
    error: null,
  };
  try {
    // One round trip for everything, against the catalog rather than the tables.
    const cols = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
    `;
    const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const tables = new Set(cols.map((c) => c.table_name));

    report.missingColumns = REQUIRED_COLUMNS.filter((r) => !have.has(`${r.table}.${r.column}`));
    report.missingTables = REQUIRED_TABLES.filter((r) => !tables.has(r.table));
    report.ok = !report.missingColumns.length && !report.missingTables.length;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}

/**
 * Run the check and alert if the schema is behind. Called once at boot, and exposed
 * on the health endpoint so it can be checked deliberately.
 */
export async function verifySchemaOnBoot(): Promise<SchemaDriftReport> {
  const report = await checkSchemaDrift();
  if (report.error) {
    logger.warn({ err: report.error }, 'schema drift check could not run');
    return report;
  }
  if (report.ok) return report;

  const missing = [
    ...report.missingTables.map((t) => `table ${t.table} (${t.since})`),
    ...report.missingColumns.map((c) => `${c.table}.${c.column} (${c.since})`),
  ];
  const pending = [
    ...new Set([...report.missingTables, ...report.missingColumns].map((x) => x.since)),
  ];

  logger.error({ missing }, 'DATABASE SCHEMA IS BEHIND THE DEPLOYED CODE');
  sendAlert({
    // Fixed fingerprint: this is one condition, and it should alert once an hour
    // while it lasts rather than once per missing column.
    fingerprint: 'schema-drift',
    title: 'Database schema is behind the deployed code',
    detail:
      'The deployed code expects things the database does not have, so queries against ' +
      'those tables will fail — including screens unrelated to the feature that added them.\n\n' +
      'Fix:\n  pnpm db:migrate:deploy\n\nNo redeploy is needed afterwards.\n\n' +
      `Migrations that appear not to have run: ${pending.join(', ')}\n\nMissing:\n  ` +
      missing.join('\n  '),
  });
  return report;
}

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Static cover for the catalog/schema fixes that have no route to drive:
 *   - the boot-time schema check names columns and tables that really exist, each
 *     against the migration that created it;
 *   - 0115 re-seeds exactly the reference rows 0029 seeds, only into an empty table.
 */
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');
const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

function modelBody(name: string): string | null {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  return m ? m[1]! : null;
}

describe('audit: boot-time schema check (src/lib/schemaCheck.ts)', () => {
  it('every required column is in schema.prisma and is added by the migration it names', async () => {
    const { REQUIRED_COLUMNS } = await import('../../src/lib/schemaCheck.js');
    for (const c of REQUIRED_COLUMNS) {
      const body = modelBody(c.table);
      expect(body, `model ${c.table}`).not.toBeNull();
      expect(body!, `${c.table}.${c.column}`).toMatch(new RegExp(`^\\s+${c.column}\\s`, 'm'));
      const sql = fs.readFileSync(path.join(MIGRATIONS, c.since, 'migration.sql'), 'utf8');
      expect(sql, `${c.since} adds ${c.table}.${c.column}`).toContain(`"${c.column}"`);
    }
  });

  it('every required table is a model and is created by the migration it names', async () => {
    const { REQUIRED_TABLES } = await import('../../src/lib/schemaCheck.js');
    for (const t of REQUIRED_TABLES) {
      expect(modelBody(t.table), `model ${t.table}`).not.toBeNull();
      const sql = fs.readFileSync(path.join(MIGRATIONS, t.since, 'migration.sql'), 'utf8');
      expect(sql, `${t.since} creates ${t.table}`).toMatch(
        new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${t.table}"`),
      );
    }
  });
});

describe('audit: 0115 re-seeds the 0029 reference rows for a fresh database', () => {
  const sql0029 = fs.readFileSync(
    path.join(MIGRATIONS, '0029_bom_vendor_sections/migration.sql'),
    'utf8',
  );
  const sql0115 = fs.readFileSync(
    path.join(MIGRATIONS, '0115_catalog_indexes_and_seed_gap/migration.sql'),
    'utf8',
  );
  const tuples = (sql: string, re: RegExp) =>
    [...sql.matchAll(re)].map((m) => m.slice(1).join('|')).sort();

  it('powder brands: same ids, names and order as 0029', () => {
    const re = /\('(pcb_[a-z]+)',\s*'([A-Za-z]+)',\s*(\d+)\)/g;
    expect(tuples(sql0115, re)).toEqual(tuples(sql0029, re));
    expect(tuples(sql0115, re)).toHaveLength(2);
  });

  it('finance factors: same ids, terms, factors and order as 0029', () => {
    const re = /\('(ff_term_\d+)',\s*(\d+),\s*([\d.]+)(?:::DECIMAL\(10,6\))?,\s*(\d+)\)/g;
    expect(tuples(sql0115, re)).toEqual(tuples(sql0029, re));
    expect(tuples(sql0115, re)).toHaveLength(5);
  });

  it('only into an empty table, and never conflicting with an existing row', () => {
    for (const table of ['PowderColorBrand', 'FinanceFactor']) {
      expect(sql0115).toContain(`WHERE NOT EXISTS (SELECT 1 FROM "${table}")`);
    }
    expect(sql0115.match(/ON CONFLICT DO NOTHING;/g)).toHaveLength(2);
    // Additive only: no unique index (production may hold case-variant part numbers).
    expect(sql0115).not.toMatch(/CREATE UNIQUE INDEX/i);
  });
});

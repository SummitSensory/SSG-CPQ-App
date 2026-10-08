import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Audit: static checks over prisma/migrations.
 *
 * docs/database-migrations.md says every migration from "about 0029" onward is guarded
 * (idempotent) so a half-applied run can be repaired by re-running it. In fact
 * 0029–0075 are largely UNGUARDED; consistent guarding starts at 0076. Those files are
 * already applied in production and must never be edited (Prisma checksums them), so
 * this test PINS the known-unguarded set: any NEW migration with an unguarded
 * statement, or a destructive one, fails here.
 */
const DIR = path.resolve(__dirname, '../../prisma/migrations');

function statements(sql: string): string[] {
  const src = sql.replace(/--[^\n]*/g, '');
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (!inQuote && src.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i++;
      continue;
    }
    if (!inDollar && c === "'") inQuote = !inQuote;
    if (c === ';' && !inDollar && !inQuote) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((s) => s.replace(/\s+/g, ' '));
}

type Finding = { migration: string; kind: string; sql: string };

function scan(from: string): Finding[] {
  const found: Finding[] = [];
  for (const m of fs.readdirSync(DIR).sort()) {
    if (m < from) continue;
    const file = path.join(DIR, m, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    for (const s of statements(fs.readFileSync(file, 'utf8'))) {
      const u = s.toUpperCase();
      if (u.startsWith('DO ') || u === 'BEGIN' || u === 'COMMIT') continue;
      const guarded = /IF NOT EXISTS|IF EXISTS|ON CONFLICT/.test(u);
      let kind: string | null = null;
      if (/^DROP (TABLE|TYPE)/.test(u) || /DROP COLUMN/.test(u))
        kind = guarded ? 'destructive-guarded' : 'destructive';
      else if (/ALTER COLUMN \S+ (SET DATA )?TYPE /.test(u)) kind = 'type-change';
      else if (/^(CREATE|ALTER TABLE)/.test(u) && !guarded) {
        if (/^ALTER TABLE \S+ ALTER COLUMN \S+ (SET|DROP) (DEFAULT|NOT NULL)/.test(u)) continue;
        kind = 'unguarded-ddl';
      } else if (/^ALTER TYPE .* ADD VALUE/.test(u) && !guarded) kind = 'unguarded-enum';
      else if (/^INSERT/.test(u) && !guarded) kind = 'insert-no-conflict';
      else if (/^(DELETE|TRUNCATE)/.test(u)) kind = 'data-delete';
      if (kind) found.push({ migration: m, kind, sql: s.slice(0, 160) });
    }
  }
  return found;
}

/** Applied in production; cannot be changed. Pinned so the list can only shrink. */
const KNOWN_UNGUARDED = [
  '0029_bom_vendor_sections',
  '0030_requirement_task_updated_by',
  '0031_bom_display_options',
  '0033_sku_freight',
  '0038_freight_rfq',
  '0039_rfq_vendor_abbrev',
  '0040_note_trigger_parts',
  '0041_note_condition',
  '0042_customer_notes',
  '0043_qbo_billing_lifecycle',
  '0044_proposal_archive',
  '0045_freight_trueup',
  '0046_admin_ops_changes',
  '0047_vendor_part_numbers',
  '0048_paint_color_groups',
  '0049_ship_to_and_deal_figures',
  '0050_esign',
  '0051_finance_rate_cards',
  '0052_follow_up_email_log',
  '0053_follow_up_templates',
  '0056_vendor_color_palettes',
  '0057_portal_delivery',
  '0060_cross_border',
  '0064_vendor_invoice',
  '0065_entity_revision',
  '0066_invoice_not_billed',
  '0067_canada_simple_mode',
  '0068_rfq_delivery',
  '0069_freight_absolute',
  '0071_payment_template_pairing',
  '0075_legal_documents',
];

describe('audit: migration history hygiene', () => {
  it('every migration folder has a migration.sql', () => {
    const missing = fs
      .readdirSync(DIR)
      .filter((d) => fs.statSync(path.join(DIR, d)).isDirectory())
      .filter((d) => !fs.existsSync(path.join(DIR, d, 'migration.sql')));
    expect(missing).toEqual([]);
  });

  it('no migration from 0029 on outside the pinned legacy set has an unguarded statement', () => {
    const offenders = scan('0029').filter(
      (f) =>
        ['unguarded-ddl', 'unguarded-enum', 'insert-no-conflict'].includes(f.kind) &&
        !KNOWN_UNGUARDED.includes(f.migration),
    );
    expect(offenders).toEqual([]);
  });

  it('the pinned legacy set is exact (shrinks only if history is squashed)', () => {
    const actual = [
      ...new Set(
        scan('0029')
          .filter((f) => ['unguarded-ddl', 'unguarded-enum', 'insert-no-conflict'].includes(f.kind))
          .map((f) => f.migration),
      ),
    ].sort();
    expect(actual).toEqual([...KNOWN_UNGUARDED].sort());
  });

  it('no unguarded destructive DDL, type change or data delete from 0029 on', () => {
    const risky = scan('0029').filter((f) =>
      ['destructive', 'type-change', 'data-delete'].includes(f.kind),
    );
    expect(risky).toEqual([]);
  });

  it('the only guarded column drops are 0097 (documented as carrying no data)', () => {
    const drops = scan('0029').filter((f) => f.kind === 'destructive-guarded');
    expect([...new Set(drops.map((d) => d.migration))]).toEqual(['0097_section_b_items_list']);
  });
});

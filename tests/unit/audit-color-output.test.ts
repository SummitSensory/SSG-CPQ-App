import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

const { rollUpBomLines, rollUpProcurementLines } = await import('../../src/handoff/bomRollup.js');
const { lineColorFor } = await import('../../src/portal/colorAreas.js');

/**
 * AUDIT — the pure halves of the colour OUTPUT stage (see the integration file
 * tests/integration/audit-color-output.test.ts for the real-database half).
 *
 * "BUG:" tests are `it.fails`: they assert the correct behaviour and fail today.
 */

type Chart = Array<{ name: string; code: string }>;
const chartFile = (f: string): Chart =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'prisma', 'data', 'powder-charts', f), 'utf8'),
  ) as Chart;
const CARDINAL = chartFile('cardinal.json');
const PRISMATIC = chartFile('prismatic.json');

describe('the portal powder charts (prisma/data/powder-charts)', () => {
  it('no code repeats within a chart or across Cardinal and Prismatic (case-insensitive)', () => {
    const all = [...CARDINAL, ...PRISMATIC].map((c) => c.code.trim().toUpperCase());
    expect(new Set(all).size).toBe(all.length);
    for (const c of [...CARDINAL, ...PRISMATIC]) {
      expect(c.code, c.name).toBe(c.code.trim());
      expect(c.code, c.name).not.toBe('');
      expect(c.name.trim(), c.code).not.toBe('');
    }
  });

  it('a bracketed duplicate name carries its OWN code, so the printed text drops it cleanly', () => {
    for (const c of CARDINAL) {
      const m = /\(([^()]*)\)$/.exec(c.name);
      if (m) expect(m[1], c.name).toBe(c.code);
    }
    // And the bare names they leave behind are what makes them duplicates.
    const bare = CARDINAL.map((c) => c.name.replace(/\s*\([^()]*\)$/, ''));
    const bracketed = CARDINAL.filter((c) => /\)$/.test(c.name)).length;
    expect(bracketed).toBeGreaterThan(0);
    expect(new Set(bare).size).toBeLessThan(CARDINAL.length);
  });

  it('a colour from one brand never borrows a name from the other brand’s chart', () => {
    const chart = [
      ...CARDINAL.map((c) => ({
        vendor: 'Goldberg Brothers',
        palette: 'Cardinal',
        vendorCode: c.code,
        name: c.name,
      })),
      ...PRISMATIC.map((c) => ({
        vendor: 'Goldberg Brothers',
        palette: 'Prismatic',
        vendorCode: c.code,
        name: c.name,
      })),
    ];
    const brands = [
      { id: 'c', name: 'Cardinal' },
      { id: 'p', name: 'Prismatic' },
    ];
    const pc = PRISMATIC[0]!;
    const cc = CARDINAL[0]!;
    expect(lineColorFor({ brand: 'cardinal', code: pc.code }, brands, chart).powderColor).toBe(
      `Cardinal ${pc.code}`,
    );
    expect(lineColorFor({ brand: 'prismatic', code: cc.code }, brands, chart).powderColor).toBe(
      `Prismatic ${cc.code}`,
    );
    // The portal's lower-case brand prints with the managed brand's spelling.
    expect(lineColorFor({ brand: 'PRISMATIC', code: pc.code }, brands, chart).powderColor).toBe(
      `Prismatic ${pc.name} ${pc.code}`,
    );
  });
});

/** A built BOM line with only what the roll-up reads. */
const bomLine = (sku: string, quantity: number, powderColor: string) => ({
  id: sku,
  sku,
  lineNo: sku,
  vendorSku: '',
  name: sku,
  quantity,
  unitCostMinor: 100,
  extendedCostMinor: 100 * quantity,
  unitWeightLbs: 1,
  extendedWeightLbs: quantity,
  vendor: 'Fab',
  vendorNotes: '',
  isHardware: true,
  powderColor,
});

describe('the eye-bolt roll-up and colour', () => {
  it('the same part in two colours is NOT merged when it is not a roll-up part', () => {
    const out = rollUpBomLines([
      bomLine('6820H-LP-ZP', 1, 'x'), // forces the roll-up pass to run
      bomLine('POST', 2, 'Cardinal Blue'),
      bomLine('POST', 3, 'Prismatic Pink'),
    ]);
    expect(out.filter((l) => l.sku === 'POST').map((l) => l.powderColor)).toEqual([
      'Cardinal Blue',
      'Prismatic Pink',
    ]);
  });

  it.fails(
    'BUG: a coloured variant folded into an uncoloured base line loses its colour (bomRollup.ts:229-253 never reads powderColor)',
    () => {
      const out = rollUpBomLines([
        bomLine('6820H-LP', 2, ''),
        bomLine('6820H-LP-ZP', 1, 'Cardinal Black T009-BK01'),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]!.powderColor).toContain('T009-BK01');
    },
  );

  it.fails(
    'BUG: the order screen’s roll-up (rollUpProcurementLines) loses a variant’s colour the same way',
    () => {
      const out = rollUpProcurementLines([
        { sku: '6820H-LP', vendor: 'Fab', quantity: 2, unitCostMinor: 100, powderColor: null },
        {
          sku: '6820H-LP-ZP',
          vendor: 'Fab',
          quantity: 1,
          unitCostMinor: 100,
          powderColor: 'Cardinal Black T009-BK01',
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]!.powderColor ?? '').toContain('T009-BK01');
    },
  );
});

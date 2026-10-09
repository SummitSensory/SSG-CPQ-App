import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * AUDIT — stage 1 of the customer-colour → Bill of Materials pipeline: INGESTION.
 *
 * The Customer-Portal (separate repo) saves a customer's colour picks as JSON into the
 * monday Manufacturing Process board's "Portal: Color Selection Answers (JSON)" long-text
 * column and flips "Portal: Color Selections" to ✅ on confirm. The CRM reads that column
 * into OrderPortalItem(kind COLOR).answers and flattens it with colorAreasOf().
 *
 * Everything here is driven through the CRM's REAL parsing functions with samples taken
 * from the portal's own code and data:
 *   - Customer-Portal pages/api/portal/color-selection.js  — the snapshot written
 *     ({ selections, totalUpcharge, confirmedAt }) via writeColorSelectionSnapshot
 *   - Customer-Portal lib/colorRequirements.js             — every input/part (area)
 *   - Customer-Portal lib/colorCatalog.js + lib/data/*.json — every brand and code
 *
 * The final describe block imports the portal's own modules from the local checkout
 * (C:\dev\Customer-Portal) when it exists, so drift between the two repos fails here
 * rather than on a vendor sheet. It is skipped where the checkout is absent (CI).
 */

import {
  colorAreasOf,
  isAreaKey,
  areaLabel,
  lineColorFor,
  planColorApplication,
  resolvePowderBrand,
  type ManagedBrand,
  type PowderChartColor,
  type PlanLine,
} from '../../src/portal/colorAreas.js';
import {
  MFG_PORTAL_COL,
  parseAnswers,
  stateFromLabel,
  contentHashOf,
  displayOf,
} from '../../src/portal/orderPortal.js';
import type { ResolvedColorSpec } from '../../src/vendorColors/service.js';
import { KNOWN_PORTAL_AREAS, PORTAL_VINYL_NAMES } from '../../src/portal/knownAreas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHART_DIR = join(HERE, '..', '..', 'prisma', 'data', 'powder-charts');
const PORTAL_ROOT = process.env.CUSTOMER_PORTAL_DIR ?? 'C:/dev/Customer-Portal';
const PORTAL_PRESENT = existsSync(join(PORTAL_ROOT, 'lib', 'colorRequirements.js'));

/* ─────────────────────────── samples copied from the portal ─────────────────────────── */

/** Every {input: [parts]} the portal can write, and the brands each allows — see src/portal/knownAreas.ts. */
const PORTAL_AREAS = KNOWN_PORTAL_AREAS;

/** Customer-Portal lib/data/vinylColors.json names — the vinyl "code" IS the name. */
const VINYL = PORTAL_VINYL_NAMES;
/** Customer-Portal lib/colorCatalog.js SLIDE_COLORS (brand 'plastic'). */
const PLASTIC = ['Blue', 'Green'];
/** Customer-Portal lib/colorCatalog.js FOUNDATION_MAT_COLORS (brand 'foundation'). */
const FOUNDATION = ['Black/Gray', 'Red/Blue', 'Green/Gray'];

interface ChartRow {
  name: string;
  code: string;
}
const readChart = (file: string): ChartRow[] =>
  JSON.parse(readFileSync(join(CHART_DIR, file), 'utf8')) as ChartRow[];
const CARDINAL = readChart('cardinal.json');
const PRISMATIC = readChart('prismatic.json');

/** The managed powder brands as migration 0029 seeds them. */
const BRANDS: ManagedBrand[] = [
  { id: 'pcb_cardinal', name: 'Cardinal' },
  { id: 'pcb_prismatic', name: 'Prismatic' },
];

/** The chart exactly as loadPowderChart() returns it after load-powder-charts.ts --apply. */
const CHART: PowderChartColor[] = [
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

/** Exactly what pages/api/portal/color-selection.js hands writeColorSelectionSnapshot. */
function portalSnapshot(
  selections: Record<string, Record<string, { brand: string; code: string }>>,
  confirmedAt: string | null = '2026-10-01T15:04:05.000Z',
  totalUpcharge = 0,
) {
  return { selections, totalUpcharge, confirmedAt };
}
/** lib/monday.js writeColorSelectionSnapshot: `{ text: JSON.stringify(data) }` — monday's `text`. */
const cellText = (snap: unknown): string => JSON.stringify(snap);

/** monday cell text → OrderPortalItem.answers → picks, through the CRM's own code. */
const ingest = (text: string | null) => colorAreasOf(parseAnswers(text));

/* ──────────────────────────────────── the contract ──────────────────────────────────── */

describe('column contract: the CRM reads the column the portal writes', () => {
  it('COLOR answers = long_text_mm6vj4d9, status = color_mm51hjph (portal MONDAY_COL_COLOR_SNAPSHOT / portalColors)', () => {
    // Customer-Portal claude-project-docs/color-selection-native-picker-build-2026-09-01.md:61
    // created long_text_mm6vj4d9; lib/monday.js:85 defaults portalColors to color_mm51hjph.
    expect(MFG_PORTAL_COL.COLOR).toEqual({
      status: 'color_mm51hjph',
      answers: 'long_text_mm6vj4d9',
    });
  });

  it("the portal's done label ✅ (lib/monday.js PORTAL_DONE_LABEL) reads as PROVIDED", () => {
    expect(stateFromLabel('✅')).toBe('PROVIDED');
    expect(stateFromLabel(' ✅ ')).toBe('PROVIDED');
    expect(stateFromLabel('🚫')).toBe('NOT_PROVIDED');
    expect(stateFromLabel('')).toBe('NOT_PROVIDED');
    expect(stateFromLabel('N/A')).toBe('NA');
  });

  it('INFO: ✅ followed by the emoji variation selector (U+FE0F) is NOT read as PROVIDED', () => {
    // The portal writes the bare U+2705 unless MONDAY_PORTAL_DONE_LABEL overrides it. If
    // the board label were ever "✅️", every colour answer would be dropped as not given.
    expect(stateFromLabel('✅\uFE0F')).toBe('NOT_PROVIDED');
  });
});

describe('snapshot shape: { selections: { <input>: { <part>: { brand, code } } }, totalUpcharge, confirmedAt }', () => {
  const snap = portalSnapshot(
    {
      structure_frame_paint: {
        legs: { brand: 'cardinal', code: 'T009-BG01' },
        horizontal_beams: { brand: 'prismatic', code: 'PRB-2826' },
        ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009-BL05' },
      },
      adventure_mat: { adventure_mat_system: { brand: 'vinyl', code: 'Kelly Green' } },
      slide: { slide_color: { brand: 'plastic', code: 'Blue' } },
      foundation_mat: { foundation_mat: { brand: 'foundation', code: 'Black/Gray' } },
    },
    '2026-10-01T15:04:05.000Z',
    500,
  );

  it('round-trips through the monday cell text field-for-field', () => {
    const answers = parseAnswers(cellText(snap));
    expect(answers).toEqual(snap);
    expect(ingest(cellText(snap))).toEqual([
      {
        areaKey: 'adventure_mat.adventure_mat_system',
        group: 'adventure_mat',
        area: 'adventure_mat_system',
        brand: 'vinyl',
        code: 'Kelly Green',
      },
      {
        areaKey: 'foundation_mat.foundation_mat',
        group: 'foundation_mat',
        area: 'foundation_mat',
        brand: 'foundation',
        code: 'Black/Gray',
      },
      {
        areaKey: 'slide.slide_color',
        group: 'slide',
        area: 'slide_color',
        brand: 'plastic',
        code: 'Blue',
      },
      {
        areaKey: 'structure_frame_paint.horizontal_beams',
        group: 'structure_frame_paint',
        area: 'horizontal_beams',
        brand: 'prismatic',
        code: 'PRB-2826',
      },
      {
        areaKey: 'structure_frame_paint.ladder_rungs_and_leg',
        group: 'structure_frame_paint',
        area: 'ladder_rungs_and_leg',
        brand: 'cardinal',
        code: 'T009-BL05',
      },
      {
        areaKey: 'structure_frame_paint.legs',
        group: 'structure_frame_paint',
        area: 'legs',
        brand: 'cardinal',
        code: 'T009-BG01',
      },
    ]);
  });

  it('ignores the sibling keys totalUpcharge / confirmedAt (they are not areas)', () => {
    const keys = ingest(cellText(snap)).map((p) => p.group);
    expect(keys).not.toContain('totalUpcharge');
    expect(keys).not.toContain('confirmedAt');
  });

  it('the content hash ignores key order, so a re-sync of the same answers is not "new"', () => {
    const reordered = JSON.parse(
      JSON.stringify({
        confirmedAt: snap.confirmedAt,
        totalUpcharge: snap.totalUpcharge,
        selections: snap.selections,
      }),
    ) as unknown;
    expect(contentHashOf('PROVIDED', reordered)).toBe(contentHashOf('PROVIDED', snap));
  });
});

/* ──────────────────────────────────────── areas ─────────────────────────────────────── */

describe('every area the portal can ask reaches the CRM as a well-formed area key', () => {
  const all = Object.entries(PORTAL_AREAS).flatMap(([input, { brands, parts }]) =>
    parts.map((part) => ({ input, part, brand: brands[0]! })),
  );

  it('there are 40 portal areas (16 inputs)', () => {
    expect(Object.keys(PORTAL_AREAS)).toHaveLength(16);
    expect(all).toHaveLength(40);
  });

  it.each(all)('$input.$part passes AREA_KEY_RE and survives ingestion', ({ input, part }) => {
    const key = `${input}.${part}`;
    expect(isAreaKey(key)).toBe(true);
    expect(areaLabel(key)).not.toBe('');
    const sample = { brand: 'vinyl', code: 'Navy' };
    const picks = ingest(cellText(portalSnapshot({ [input]: { [part]: sample } })));
    expect(picks).toEqual([{ areaKey: key, group: input, area: part, ...sample }]);
  });

  it('one snapshot with every area answered yields exactly one pick per area, none dropped', () => {
    const selections: Record<string, Record<string, { brand: string; code: string }>> = {};
    for (const { input, part } of all) {
      (selections[input] ??= {})[part] = { brand: 'vinyl', code: 'Tan' };
    }
    const picks = ingest(cellText(portalSnapshot(selections)));
    expect(picks.map((p) => p.areaKey).sort()).toEqual(
      all.map(({ input, part }) => `${input}.${part}`).sort(),
    );
  });

  it('an area with no mapping is REPORTED at review (unmappedAreas), never dropped silently', () => {
    const picks = ingest(
      cellText(
        portalSnapshot({ soft_steps_3_mat: { soft_steps_3: { brand: 'vinyl', code: 'Red' } } }),
      ),
    );
    const { result } = planColorApplication({
      picks,
      mapping: new Map(),
      lines: [],
      submittedVendors: new Set(),
      brands: BRANDS,
      chart: CHART,
    });
    expect(result.unmappedAreas).toEqual(['soft_steps_3_mat.soft_steps_3']);
  });
});

/* ──────────────────────────────────── brands & codes ────────────────────────────────── */

describe('brand spelling: the portal writes lower-case brands', () => {
  it('cardinal / prismatic resolve to the managed powder brands seeded by migration 0029', () => {
    expect(resolvePowderBrand('cardinal', BRANDS)?.id).toBe('pcb_cardinal');
    expect(resolvePowderBrand('prismatic', BRANDS)?.id).toBe('pcb_prismatic');
    expect(resolvePowderBrand('Cardinal', BRANDS)?.id).toBe('pcb_cardinal');
    expect(resolvePowderBrand(' PRISMATIC ', BRANDS)?.id).toBe('pcb_prismatic');
  });

  it('vinyl / plastic / foundation are materials, not powder brands', () => {
    for (const b of ['vinyl', 'plastic', 'foundation', 'ball_pit_balls']) {
      expect(resolvePowderBrand(b, BRANDS)).toBeNull();
    }
  });
});

describe('every Cardinal and Prismatic code resolves to its named chart colour', () => {
  it('the CRM charts carry 131 Cardinal and 378 Prismatic colours, codes unique and trimmed', () => {
    expect(CARDINAL).toHaveLength(131);
    expect(PRISMATIC).toHaveLength(378);
    for (const list of [CARDINAL, PRISMATIC]) {
      expect(new Set(list.map((c) => c.code)).size).toBe(list.length);
      expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
      for (const c of list) {
        expect(c.code).toBe(c.code.trim());
        expect(c.code).not.toBe('');
        expect(c.name).toBe(c.name.trim());
      }
    }
    const cardinal = new Set(CARDINAL.map((c) => c.code.toLowerCase()));
    expect(PRISMATIC.filter((p) => cardinal.has(p.code.toLowerCase()))).toEqual([]);
  });

  const bare = (name: string, code: string) =>
    name.endsWith(` (${code})`) ? name.slice(0, -` (${code})`.length) : name;

  it.each(CARDINAL)('cardinal $code → "Cardinal <name> <code>"', ({ name, code }) => {
    const out = lineColorFor({ brand: 'cardinal', code }, BRANDS, CHART);
    expect(out).toEqual({
      powderBrandId: 'pcb_cardinal',
      powderColorCode: code,
      powderColor: `Cardinal ${bare(name, code)} ${code}`,
    });
  });

  it.each(PRISMATIC)('prismatic $code → "Prismatic <name> <code>"', ({ name, code }) => {
    const out = lineColorFor({ brand: 'prismatic', code }, BRANDS, CHART);
    expect(out).toEqual({
      powderBrandId: 'pcb_prismatic',
      powderColorCode: code,
      powderColor: `Prismatic ${name} ${code}`,
    });
  });

  it('a Cardinal code never resolves under the Prismatic brand (no cross-brand name)', () => {
    expect(lineColorFor({ brand: 'prismatic', code: 'T009-BG01' }, BRANDS, CHART).powderColor).toBe(
      'Prismatic T009-BG01',
    );
  });
});

describe('material colours print as "<Material> <name>" with no powder brand', () => {
  const cases = [
    ...VINYL.map((c) => ({ brand: 'vinyl', code: c, label: `Vinyl ${c}` })),
    ...PLASTIC.map((c) => ({ brand: 'plastic', code: c, label: `Plastic ${c}` })),
    ...FOUNDATION.map((c) => ({ brand: 'foundation', code: c, label: `Foundation ${c}` })),
  ];
  it.each(cases)('$brand $code', ({ brand, code, label }) => {
    expect(lineColorFor({ brand, code }, BRANDS, CHART)).toEqual({
      powderBrandId: null,
      powderColorCode: null,
      powderColor: label,
    });
  });
});

describe('multi-piece parts: every portal vinyl name resolves to a piece', () => {
  // A colour-spec palette administered with the portal's own vinyl names. The CRM
  // matches by NAME first (case-insensitive), then vendor code.
  const spec = (slotCount: number): ResolvedColorSpec => ({
    specId: 's',
    slotCount,
    required: false,
    slotUpchargeMinor: 0,
    slotLabels: [],
    notes: null,
    palette: {
      id: 'p',
      name: 'Resilite Vinyl',
      finishType: 'VINYL',
      manufacturerId: 'm',
      manufacturerName: 'Resilite',
    },
    colors: VINYL.map((n, i) => ({ id: `c${i}`, name: n, vendorCode: n, upchargeMinor: 0 })),
  });
  const line: PlanLine = {
    id: 'L1',
    sku: 'RPAL6868',
    vendor: 'Resilite',
    isHardwareComponent: false,
    powderBrandId: null,
    powderColorCode: null,
    powderColor: null,
  };

  const systems = [
    { input: 'palisades_mat', parts: PORTAL_AREAS.palisades_mat!.parts },
    { input: 'climb_slide_mat', parts: PORTAL_AREAS.climb_slide_mat!.parts },
    { input: 'soft_steps_2_mat', parts: PORTAL_AREAS.soft_steps_2_mat!.parts },
    { input: 'soft_steps_3_mat', parts: PORTAL_AREAS.soft_steps_3_mat!.parts },
  ];

  it.each(systems)(
    '$input: each piece × every vinyl colour lands on its slot',
    ({ input, parts }) => {
      for (const colour of VINYL) {
        const selections = {
          [input]: Object.fromEntries(parts.map((p) => [p, { brand: 'vinyl', code: colour }])),
        };
        const picks = ingest(cellText(portalSnapshot(selections)));
        const mapping = new Map(
          parts.map((p, i) => [`${input}.${p}`, [{ sku: 'RPAL6868', piece: i + 1 }]] as const),
        );
        const { updates, result } = planColorApplication({
          picks,
          mapping,
          lines: [line],
          specs: new Map([['L1', spec(parts.length)]]),
          submittedVendors: new Set(),
          brands: BRANDS,
          chart: CHART,
        });
        expect(result.offChart).toEqual([]);
        expect(result.conflicts).toEqual([]);
        expect(updates).toHaveLength(1);
        expect(updates[0]!.to.colorPicks?.map((p) => [p.slot, p.name])).toEqual(
          parts.map((_, i) => [i + 1, colour]),
        );
      }
    },
  );
});

/* ──────────────────────────────────────── edge cases ────────────────────────────────── */

describe('edge cases on the way in', () => {
  it('missing colour (null / {} / no code) is skipped, the rest of the answer survives', () => {
    const picks = colorAreasOf({
      selections: {
        structure_frame_paint: {
          legs: null,
          horizontal_beams: {},
          ladder_rungs_and_leg: { brand: 'cardinal' },
          soar_frame: { brand: 'cardinal', code: 'T009-BG01' },
        },
      },
    });
    expect(picks.map((p) => p.areaKey)).toEqual(['structure_frame_paint.soar_frame']);
  });

  it('an empty or whitespace-only code is not a pick', () => {
    expect(
      colorAreasOf({
        selections: { slide: { slide_color: { brand: 'plastic', code: '' } } },
      }),
    ).toEqual([]);
    expect(
      colorAreasOf({
        selections: { slide: { slide_color: { brand: 'plastic', code: '   ' } } },
      }),
    ).toEqual([]);
  });

  it('surrounding whitespace on brand/code is trimmed', () => {
    expect(
      colorAreasOf({
        selections: {
          structure_frame_paint: { legs: { brand: ' cardinal ', code: ' T009-BG01 ' } },
        },
      }),
    ).toEqual([
      {
        areaKey: 'structure_frame_paint.legs',
        group: 'structure_frame_paint',
        area: 'legs',
        brand: 'cardinal',
        code: 'T009-BG01',
      },
    ]);
  });

  it('a missing brand prints the code alone (no powder brand)', () => {
    expect(lineColorFor({ brand: '', code: 'T009-BG01' }, BRANDS, CHART)).toEqual({
      powderBrandId: null,
      powderColorCode: null,
      powderColor: 'T009-BG01',
    });
  });

  it('INFO: an unknown powder code is accepted and printed without a name — no warning is raised', () => {
    // The portal rejects unknown codes before saving (validatePartSelection), so this
    // only arises from a hand-edited cell or a code retired from the CRM chart.
    expect(lineColorFor({ brand: 'cardinal', code: 'ZZZ-000' }, BRANDS, CHART)).toEqual({
      powderBrandId: 'pcb_cardinal',
      powderColorCode: 'ZZZ-000',
      powderColor: 'Cardinal ZZZ-000',
    });
  });

  it('a lower-case code still finds the chart name; the code prints as given', () => {
    // The portal validates codes case-sensitively, so it never writes lower case.
    expect(lineColorFor({ brand: 'cardinal', code: 't009-bg01' }, BRANDS, CHART).powderColor).toBe(
      'Cardinal Almond 90 Gloss t009-bg01',
    );
  });

  it('Cardinal duplicate-name colours print once, without the bracketed code', () => {
    expect(lineColorFor({ brand: 'cardinal', code: 'T009-BL05' }, BRANDS, CHART).powderColor).toBe(
      'Cardinal Blue 90 Gloss T009-BL05',
    );
    expect(lineColorFor({ brand: 'cardinal', code: 'T009-BL01' }, BRANDS, CHART).powderColor).toBe(
      'Cardinal Blue 90 Gloss T009-BL01',
    );
  });

  it('unreadable cell text is kept as { text } and yields no picks', () => {
    expect(parseAnswers('{"selections": {')).toEqual({ text: '{"selections": {' });
    expect(ingest('{"selections": {')).toEqual([]);
    expect(ingest('')).toEqual([]);
    expect(ingest(null)).toEqual([]);
  });

  it('odd shapes are tolerated: selections missing, null, array, string', () => {
    expect(colorAreasOf({})).toEqual([]);
    expect(colorAreasOf({ selections: null })).toEqual([]);
    expect(colorAreasOf({ selections: 'x' })).toEqual([]);
    expect(colorAreasOf({ selections: { structure_frame_paint: 'x' } })).toEqual([]);
    expect(colorAreasOf([])).toEqual([]);
  });

  it('a duplicate area key in the raw cell: JSON.parse keeps the LAST value', () => {
    const raw =
      '{"selections":{"structure_frame_paint":{"legs":{"brand":"cardinal","code":"T009-BG01"},"legs":{"brand":"cardinal","code":"T009-BL05"}}},"confirmedAt":null}';
    expect(ingest(raw)).toEqual([
      expect.objectContaining({ areaKey: 'structure_frame_paint.legs', code: 'T009-BL05' }),
    ]);
  });

  it('two areas on one part with different colours → conflict, line untouched', () => {
    // e.g. the retired adventure_mat.zip_line still sitting beside the new
    // adventure_mat.adventure_mat_system (RETIRED_PARTS keeps old picks alive).
    const picks = ingest(
      cellText(
        portalSnapshot({
          adventure_mat: {
            adventure_mat_system: { brand: 'vinyl', code: 'Navy' },
            zip_line: { brand: 'vinyl', code: 'Lime' },
          },
        }),
      ),
    );
    const { updates, result } = planColorApplication({
      picks,
      mapping: new Map([
        ['adventure_mat.adventure_mat_system', ['ZIP-1']],
        ['adventure_mat.zip_line', ['ZIP-1']],
      ]),
      lines: [
        {
          id: 'L1',
          sku: 'ZIP-1',
          vendor: 'Resilite',
          isHardwareComponent: false,
          powderBrandId: null,
          powderColorCode: null,
          powderColor: null,
        },
      ],
      submittedVendors: new Set(),
      brands: BRANDS,
      chart: CHART,
    });
    expect(updates).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        sku: 'ZIP-1',
        areas: [
          'adventure_mat.adventure_mat_system: vinyl Navy',
          'adventure_mat.zip_line: vinyl Lime',
        ],
      },
    ]);
  });

  it('re-submission with a changed colour moves the hash, so a reviewed item becomes NEW again', () => {
    const first = portalSnapshot({
      structure_frame_paint: { legs: { brand: 'cardinal', code: 'T009-BG01' } },
    });
    const second = portalSnapshot({
      structure_frame_paint: { legs: { brand: 'prismatic', code: 'PRB-2826' } },
    });
    const h1 = contentHashOf('PROVIDED', parseAnswers(cellText(first)));
    const h2 = contentHashOf('PROVIDED', parseAnswers(cellText(second)));
    expect(h1).not.toBe(h2);
    expect(displayOf({ state: 'PROVIDED', contentHash: h1, reviewedHash: h1 })).toBe('REVIEWED');
    expect(displayOf({ state: 'PROVIDED', contentHash: h2, reviewedHash: h1 })).toBe('NEW');
    expect(ingest(cellText(second))[0]).toMatchObject({ brand: 'prismatic', code: 'PRB-2826' });
  });

  it('INFO: an unconfirmed draft (confirmedAt null) parses exactly like a confirmed answer', () => {
    // The CRM relies on the ✅ status, not confirmedAt, to decide the answer is final.
    const draft = portalSnapshot(
      { structure_frame_paint: { legs: { brand: 'cardinal', code: 'T009-BG01' } } },
      null,
    );
    expect(ingest(cellText(draft))).toHaveLength(1);
  });
});

/* ───────────────────────── live cross-check against the portal checkout ───────────────────────── */

interface PortalRequirements {
  allKnownInputParts(): Record<string, string[]>;
  ALLOWED_BRANDS: Record<string, string[]>;
}
interface PortalValidation {
  sanitizeSelections(
    order: unknown,
    selections: unknown,
  ): Record<string, Record<string, { brand: string; code: string }>>;
  validatePartSelection(input: string, part: string, sel: unknown): string | null;
}
interface PortalCatalog {
  listCardinalColors(): Array<{ name: string; code: string }>;
  listPrismaticColors(): Array<{ name: string; sku: string }>;
  listVinylColors(): Array<{ name: string }>;
  listSlideColors(): Array<{ name: string }>;
  listFoundationMatColors(): Array<{ name: string }>;
}
const portalModule = async <T>(rel: string): Promise<T> =>
  (await import(pathToFileURL(join(PORTAL_ROOT, rel)).href)) as T;

describe.skipIf(!PORTAL_PRESENT)(
  'live cross-check: the portal checkout at C:\\dev\\Customer-Portal',
  () => {
    it('allKnownInputParts() / ALLOWED_BRANDS equal the frozen PORTAL_AREAS above', async () => {
      const req = await portalModule<PortalRequirements>('lib/colorRequirements.js');
      const known = req.allKnownInputParts();
      const live = Object.fromEntries(
        Object.entries(known)
          .filter(([, parts]) => parts.length > 0) // ball_pit_balls: no picker, never written
          .map(([k, parts]) => [k, [...parts].sort()]),
      );
      const frozen = Object.fromEntries(
        Object.entries(PORTAL_AREAS).map(([k, v]) => [k, [...v.parts].sort()]),
      );
      expect(live).toEqual(frozen);
      for (const [input, { brands }] of Object.entries(PORTAL_AREAS)) {
        expect(req.ALLOWED_BRANDS[input], input).toEqual(brands);
      }
      for (const [input, parts] of Object.entries(known)) {
        for (const p of parts) expect(isAreaKey(`${input}.${p}`), `${input}.${p}`).toBe(true);
      }
    });

    it("the portal's colour lists equal the CRM charts and the frozen material lists", async () => {
      const cat = await portalModule<PortalCatalog>('lib/colorCatalog.js');
      expect(cat.listCardinalColors().map((c) => ({ name: c.name.trim(), code: c.code }))).toEqual(
        CARDINAL.map((c) => ({ name: c.name.replace(` (${c.code})`, ''), code: c.code })),
      );
      expect(cat.listPrismaticColors().map((c) => ({ name: c.name.trim(), code: c.sku }))).toEqual(
        PRISMATIC,
      );
      expect(cat.listVinylColors().map((c) => c.name)).toEqual(VINYL);
      expect(cat.listSlideColors().map((c) => c.name)).toEqual(PLASTIC);
      expect(cat.listFoundationMatColors().map((c) => c.name)).toEqual(FOUNDATION);
    });

    it("every area × every allowed colour, through the portal's own sanitizeSelections, ingests unchanged", async () => {
      const req = await portalModule<PortalRequirements>('lib/colorRequirements.js');
      const val = await portalModule<PortalValidation>('lib/colorSelectionValidation.js');
      const codes: Record<string, string[]> = {
        cardinal: CARDINAL.map((c) => c.code),
        prismatic: PRISMATIC.map((c) => c.code),
        vinyl: [...VINYL],
        plastic: PLASTIC,
        foundation: FOUNDATION,
      };
      let checked = 0;
      for (const [input, parts] of Object.entries(req.allKnownInputParts())) {
        for (const brand of req.ALLOWED_BRANDS[input] ?? []) {
          for (const code of codes[brand] ?? []) {
            const selections = Object.fromEntries([
              [input, Object.fromEntries(parts.map((p) => [p, { brand, code }]))],
            ]);
            const clean = val.sanitizeSelections({}, selections);
            const picks = ingest(cellText(portalSnapshot(clean)));
            expect(picks.length, `${input} ${brand} ${code}`).toBe(parts.length);
            for (const p of picks) {
              expect(p).toMatchObject({ group: input, brand, code });
              const printed = lineColorFor(p, BRANDS, CHART).powderColor ?? '';
              expect(printed.endsWith(code), printed).toBe(true);
              if (brand === 'cardinal' || brand === 'prismatic') {
                // name between brand and code — never "Cardinal T009-BG01"
                expect(printed.split(' ').length, printed).toBeGreaterThan(2);
              }
            }
            checked += picks.length;
          }
        }
      }
      // 7 powder areas × 509 + 30 vinyl × 14 + 2 plastic × 2 + 1 foundation × 3
      expect(checked).toBe(3990);
    });

    it('the portal rejects (and so never writes) lower-case or padded codes', async () => {
      const val = await portalModule<PortalValidation>('lib/colorSelectionValidation.js');
      expect(
        val.validatePartSelection('structure_frame_paint', 'legs', {
          brand: 'cardinal',
          code: 'T009-BG01',
        }),
      ).toBeNull();
      expect(
        val.validatePartSelection('structure_frame_paint', 'legs', {
          brand: 'cardinal',
          code: 't009-bg01',
        }),
      ).not.toBeNull();
      expect(
        val.validatePartSelection('structure_frame_paint', 'legs', {
          brand: 'Cardinal',
          code: 'T009-BG01',
        }),
      ).not.toBeNull();
      expect(
        val.validatePartSelection('mat_pad_color', 'mat_pad', {
          brand: 'vinyl',
          code: 'kelly green',
        }),
      ).not.toBeNull();
    });
  },
);

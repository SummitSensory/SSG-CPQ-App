import { describe, it, expect } from 'vitest';
import {
  computeAdventureBOM,
  computeAdventureProposal,
  type AdvAnswers,
} from '../../src/proposals/adventureSeries.js';
import { DEFAULT_FRAME_RULES, frameContext } from '../../src/proposals/frameRules.js';
import { evaluateRules, mergeRules } from '../../src/proposals/hardwareRules.js';
import {
  defaultSettings,
  legsForLength,
  mergeSettings,
} from '../../src/proposals/formulaSettings.js';

/** 10′ × 10′ square, 4 legs, one ladder, monkey bars, trolley, one zip line, 4 brackets. */
const answers: AdvAnswers = {
  length: 10,
  width: 10,
  config: 'Square',
  legs: 4,
  ladders: 1,
  monkeyBars: true,
  trolley: true,
  trolleyType: 'Dual',
  zipLine: true,
  zipLineQty: 1,
  brackets: true,
  bracketsQty: 4,
  swivel360: 2,
  forged: 2,
  swingHanger: 1,
  vRings: 1,
};

/**
 * Total quantity of a part across the whole BOM.
 *
 * The engine emits one row per REASON a part is needed — a 10′ × 10′ frame gives
 * two A-2410 rows, two as width end caps and one on the bay — and sums them with
 * its own qtyOf(). This helper used .find(), so it read only the first row and
 * asserted against a number the proposal never sees. Same bug the engine already
 * fixed and documented; the test kept it.
 */
const qty = (part: string, a: AdvAnswers = answers): number =>
  computeAdventureBOM(a).reduce((s, b) => (b.part === part ? s + b.qty : s), 0);

describe('frame quantities (workbook defaults, now data-driven)', () => {
  it('reproduces the v73 frame counts', () => {
    expect(qty('A-2245')).toBe(3); // legs 4 − ladders 1
    expect(qty('A-2246')).toBe(1); // one ladder bay
    expect(qty('A-2242')).toBe(4); // 4 per frame when legs > 0
    expect(qty('A-2243')).toBe(0); // only at 6 or 8 legs
    expect(qty('P-2531')).toBe(1);
    expect(qty('A-2253')).toBe(1);
    expect(qty('P-2330')).toBe(14); // monkey bars 9 + ladders 1 × 5
    expect(qty('P-2028')).toBe(8); // legs 4 × 2
    expect(qty('P-2124')).toBe(4); // saddle brackets
  });

  it('applies shape conditions', () => {
    expect(qty('A-2241', { ...answers, config: 'T-Shape' })).toBe(2);
    expect(qty('A-2241')).toBe(0);
    expect(qty('A-2244', { ...answers, config: 'L-Shape' })).toBe(1);
    // L-Shape adds one standard post and removes two mid-run posts.
    expect(qty('A-2242', { ...answers, config: 'L-Shape' })).toBe(5);
    expect(qty('A-2243', { ...answers, legs: 6, config: 'L-Shape' })).toBe(0); // 2 − 2
    expect(qty('A-2243', { ...answers, legs: 6 })).toBe(2);
    expect(qty('A-2243', { ...answers, legs: 8 })).toBe(4);
  });

  it('drops parts whose option is switched off', () => {
    const plain: AdvAnswers = { length: 10, width: 10, config: 'Square', legs: 4, ladders: 0 };
    for (const part of ['P-2024', 'A-2530', 'K-5000', 'A-2216', 'P-2018', 'TRH2005', 'P-2124']) {
      expect(qty(part, plain)).toBe(0);
    }
    expect(qty('P-2330', plain)).toBe(0); // no monkey bars, no ladders
  });

  it('adds one ladder safety shield per ladder, only when the toggle is on', () => {
    expect(qty('P-2501')).toBe(0); // toggle off in the base fixture
    expect(qty('P-2501', { ...answers, ladderShield: true })).toBe(1);
    expect(qty('P-2501', { ...answers, ladders: 3, ladderShield: true })).toBe(3);
    expect(qty('P-2501', { ...answers, ladders: 0, ladderShield: true })).toBe(0);
  });

  it('prints the ladder safety shield as a priced line on the proposal itself', () => {
    const { lines } = computeAdventureProposal({ ...answers, ladderShield: true });
    const shield = lines.find((l) => l.sku === 'P-2501');
    expect(shield).toBeTruthy();
    expect(shield!.quantity).toBe(1);
    expect(shield!.rateMinor).toBeGreaterThan(0);
    expect(shield!.needsPrice).toBeFalsy();

    const off = computeAdventureProposal(answers);
    expect(off.lines.some((l) => l.sku === 'P-2501')).toBe(false);
  });

  it('keeps the structural pieces: beam members and the sized trolley rail', () => {
    expect(qty('A-2410')).toBe(3); // short caps 2 + long 2 − monkey-bar half offset 1
    expect(qty('A-2420')).toBe(2); // monkey-bar beam on a 10′ run
    expect(qty('TR2000-A09')).toBe(2); // length 10 − 1 → A09
    expect(qty('TRH2005')).toBe(6);
    expect(qty('TRN2016')).toBe(4);
  });

  /**
   * The top of a single-bay frame is four members: two across the width, two along
   * the length. The workbook's width-cap total skipped the 6' and 7' sizes, so a
   * 10' × 7' frame kept all four at 10' (4 × A-2410 plus 2 × P-2207 = six members on
   * a four-sided frame), and its 5' row was keyed on the length, not the width.
   */
  it('puts exactly two width caps and two length members on every single-bay frame', () => {
    const mem: Record<number, string> = {
      5: 'P-2545',
      6: 'P-2206',
      7: 'P-2207',
      8: 'A-2408',
      9: 'A-2409',
      10: 'A-2410',
    };
    for (let L = 5; L <= 10; L++) {
      for (let W = 5; W <= 10; W++) {
        const a: AdvAnswers = { length: L, width: W, config: 'Rectangle', legs: 4, ladders: 0 };
        const total = Object.values(mem).reduce((s, p) => s + qty(p, a), 0);
        expect(total, `${L}×${W}`).toBe(4);
        if (L === W) expect(qty(mem[L]!, a), `${L}×${W}`).toBe(4);
        else {
          expect(qty(mem[W]!, a), `${L}×${W} width caps`).toBe(2);
          expect(qty(mem[L]!, a), `${L}×${W} length members`).toBe(2);
        }
      }
    }
  });

  it("matches Bryan's 10′ × 7′ and 10′ × 8′ traces: two 10′ members each", () => {
    // Monkey bars on, one interior beam: 2 length − 1 monkey offset + 1 interior.
    const base: Omit<AdvAnswers, 'width'> = {
      length: 10,
      config: 'Rectangle',
      legs: 4,
      ladders: 1,
      monkeyBars: true,
      interiorBeams: true,
      interiorBeamsQty: 1,
    };
    for (const [W, cap] of [
      [7, 'P-2207'],
      [8, 'A-2408'],
    ] as const) {
      const a = { ...base, width: W };
      expect(qty('A-2410', a), `10×${W}`).toBe(2);
      expect(qty(cap, a), `10×${W}`).toBe(2);
      expect(qty('A-2420', a), `10×${W}`).toBe(2);
    }
  });

  /**
   * A later bay is two more length members and one more cross member. The workbook
   * added three of the bay's length, right only when the bay equals the width.
   */
  it('sizes a multi-bay frame’s cross members by the width, its length members by the bay', () => {
    const f = (L: number, W: number, legs: number): AdvAnswers => ({
      length: L,
      width: W,
      config: 'Rectangle',
      legs,
      ladders: 0,
    });
    // 20 × 8: two 10' bays → 3 × 8' across, 4 × 10' along.
    expect(qty('A-2408', f(20, 8, 6))).toBe(3);
    expect(qty('A-2410', f(20, 8, 6))).toBe(4);
    // 18 × 10: 10' + 8' bays → 3 × 10' across + 2 × 10' along, 2 × 8' along.
    expect(qty('A-2410', f(18, 10, 6))).toBe(5);
    expect(qty('A-2408', f(18, 10, 6))).toBe(2);
    // 20 × 10 and 30 × 10 were already right and stay so.
    expect(qty('A-2410', f(20, 10, 6))).toBe(7);
    expect(qty('A-2410', f(30, 10, 8))).toBe(10);
    // 30 × 7: three 10' bays → 4 × 7' across, 6 × 10' along.
    expect(qty('P-2207', f(30, 7, 8))).toBe(4);
    expect(qty('A-2410', f(30, 7, 8))).toBe(6);
  });

  it('prints the H-1000 kit on a plain frame with no accessory hardware', () => {
    const plain: AdvAnswers = { length: 10, width: 8, config: 'Rectangle', legs: 4, ladders: 0 };
    const { lines } = computeAdventureProposal(plain);
    const kit = lines.find((l) => l.sku === 'H-1000');
    expect(kit).toBeTruthy();
    expect(kit!.rateMinor).toBeGreaterThan(0);
  });

  it('ignores leftover bracket answers once brackets are switched off', () => {
    const { lines } = computeAdventureProposal({
      ...answers,
      brackets: false,
      bracketsQty: 5,
      swivel360: 3,
    });
    expect(lines.some((l) => l.sku === '6820H-LDD')).toBe(false);
    expect(lines.some((l) => l.sku === '6820H-LAC-G')).toBe(false);
  });

  it('honours an edited coefficient without disturbing other rows', () => {
    const rules = mergeRules(DEFAULT_FRAME_RULES, [
      { part: 'P-2028', terms: [{ source: 'in:legs', coefficient: 3 }] },
    ]);
    const rows = evaluateRules(
      rules,
      frameContext(answers, () => 0),
    );
    expect((rows.find((r) => r.part === 'P-2028') || { qty: 0 }).qty).toBe(12); // legs 4 × 3
    expect((rows.find((r) => r.part === 'P-2330') || { qty: 0 }).qty).toBe(14); // untouched
  });
});

describe('business numbers', () => {
  it('resolves legs from the frame-length spans', () => {
    const s = defaultSettings();
    expect(legsForLength(10, s)).toBe(4);
    expect(legsForLength(11, s)).toBe(6);
    expect(legsForLength(20, s)).toBe(6);
    expect(legsForLength(21, s)).toBe(8);
  });

  it('applies overrides and clamps them to each range', () => {
    const s = mergeSettings([
      { key: 'depositPct', value: 30 },
      { key: 'proposalValidityDays', value: 9999 },
    ]);
    expect(s.depositPct).toBe(30);
    expect(s.proposalValidityDays).toBe(365); // clamped to the maximum
  });

  it('ignores unknown keys', () => {
    expect(mergeSettings([{ key: 'nope', value: 1 }]).depositPct).toBe(50);
  });
});

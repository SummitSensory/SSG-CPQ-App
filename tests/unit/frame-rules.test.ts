import { describe, it, expect } from 'vitest';
import { computeAdventureBOM, type AdvAnswers } from '../../src/proposals/adventureSeries.js';
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

  it('keeps the structural pieces: beam members and the sized trolley rail', () => {
    expect(qty('A-2410')).toBe(3); // short caps 2 + long 2 − monkey-bar half offset 1
    expect(qty('A-2420')).toBe(2); // monkey-bar beam on a 10′ run
    expect(qty('TR2000-A09')).toBe(2); // length 10 − 1 → A09
    expect(qty('TRH2005')).toBe(6);
    expect(qty('TRN2016')).toBe(4);
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

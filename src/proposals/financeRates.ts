import { prisma } from '../lib/prisma.js';

/**
 * Financing rate sheets: which factor applies to how much, for how long.
 *
 * Ryan Capital do not publish one factor per term. They publish a grid — amount
 * band down the side, term across the top — because the factor improves as the
 * amount rises. The CRM previously stored one factor per term, taken from the
 * $15,000–24,999 row, and applied it to every job: on a $150,000 project that
 * overstated the monthly payment by around 3%, in the customer's disfavour.
 *
 * Three rules hold here:
 *
 *   1. **The grid is data.** Bands, terms and factors are rows, so next year's sheet
 *      is loaded rather than coded. Adding a 72-month term needs no migration.
 *   2. **A missing factor means "not offered".** The 3,000–4,999 band genuinely has
 *      no 12- or 60-month option in the published sheet, so the absence of a row is
 *      the representation. A zero would print $0.00/mo and look like a bargain.
 *   3. **Sheets are versioned, and a quote can be pinned.** A card carries an
 *      effective date; the newest active card effective today is what a new quote
 *      uses. Once a financing sheet has been SENT, the version records the card it
 *      was quoted from, so loading new rates cannot restate a payment already given
 *      to a customer in writing.
 */

export interface RateTerm {
  termMonths: number;
  factor: number;
}

export interface RateBand {
  id: string;
  label: string;
  minMinor: number;
  /** Null on the top band: "and above". */
  maxMinor: number | null;
  terms: RateTerm[];
}

export interface RateCard {
  id: string;
  name: string;
  source: string | null;
  effectiveOn: Date;
  active: boolean;
  notes: string | null;
  bands: RateBand[];
  /** Every term appearing anywhere on the card, ascending. */
  termMonths: number[];
}

/** The band that applies to an amount, and whether it had to be approximated. */
export interface BandMatch {
  band: RateBand;
  /**
   * True when the amount falls outside every published band and the nearest one was
   * used. The sheet says so — an unmarked figure derived from a band that does not
   * cover the amount is a quote we cannot stand behind.
   */
  approximate: boolean;
  /** 'below' or 'above' when approximate, otherwise null. */
  direction: 'below' | 'above' | null;
}

const toCard = (row: {
  id: string;
  name: string;
  source: string | null;
  effectiveOn: Date;
  active: boolean;
  notes: string | null;
  bands: Array<{
    id: string;
    label: string;
    minMinor: number;
    maxMinor: number | null;
    rates: Array<{ termMonths: number; factor: unknown }>;
  }>;
}): RateCard => {
  const bands = row.bands
    .map((b) => ({
      id: b.id,
      label: b.label,
      minMinor: b.minMinor,
      maxMinor: b.maxMinor,
      terms: b.rates
        .map((r) => ({ termMonths: r.termMonths, factor: Number(r.factor) }))
        .sort((x, y) => x.termMonths - y.termMonths),
    }))
    .sort((a, b) => a.minMinor - b.minMinor);
  const termMonths = [...new Set(bands.flatMap((b) => b.terms.map((t) => t.termMonths)))].sort(
    (a, b) => a - b,
  );
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    effectiveOn: row.effectiveOn,
    active: row.active,
    notes: row.notes,
    bands,
    termMonths,
  };
};

const CARD_INCLUDE = {
  bands: { include: { rates: true }, orderBy: { minMinor: 'asc' } },
} as const;

/**
 * The card a new quote should use: the newest ACTIVE card whose effective date has
 * arrived. A card dated in the future is staged, not live — which is the point of
 * having a date at all.
 */
export async function currentRateCard(on: Date = new Date()): Promise<RateCard | null> {
  const row = await prisma.financeRateCard.findFirst({
    where: { active: true, effectiveOn: { lte: on } },
    orderBy: [{ effectiveOn: 'desc' }, { createdAt: 'desc' }],
    include: CARD_INCLUDE,
  });
  return row ? toCard(row) : null;
}

export async function rateCardById(id: string): Promise<RateCard | null> {
  const row = await prisma.financeRateCard.findUnique({ where: { id }, include: CARD_INCLUDE });
  return row ? toCard(row) : null;
}

/**
 * Which band covers this amount.
 *
 * Bands are half-open on the upper bound — the published sheet reads "$15,000-24,999"
 * and the workbook's own formula tests `amount < 25000`, so $24,999.50 is in the
 * 15–25k band and $25,000.00 is in the next one. Getting this wrong by a cent moves
 * a payment.
 *
 * Outside the published range the nearest band is used and flagged: below the floor
 * the lowest band, above the ceiling the highest. The alternative — refusing to quote
 * — leaves a rep with a $600,000 project and no sheet, which sends them to a
 * spreadsheet nobody audits.
 */
export function bandFor(card: RateCard, amountMinor: number): BandMatch | null {
  if (!card.bands.length) return null;
  const amount = Math.max(0, Math.round(amountMinor));

  const exact = card.bands.find(
    (b) => amount >= b.minMinor && (b.maxMinor == null || amount < b.maxMinor),
  );
  if (exact) return { band: exact, approximate: false, direction: null };

  const lowest = card.bands[0]!;
  const highest = card.bands[card.bands.length - 1]!;
  if (amount < lowest.minMinor) return { band: lowest, approximate: true, direction: 'below' };
  return { band: highest, approximate: true, direction: 'above' };
}

/* -------------------------------------------------------------------------- */
/* Pasting a sheet                                                            */
/* -------------------------------------------------------------------------- */

export interface ParsedRateBand {
  label: string;
  minMinor: number;
  maxMinor: number | null;
  factors: Record<number, number>;
}

export interface ParsedRateSheet {
  termMonths: number[];
  bands: ParsedRateBand[];
  errors: string[];
  /**
   * True when the highest band has an upper bound. Worth saying out loud on review:
   * the lessor's own top row is usually labelled with a ceiling their formulas do not
   * enforce, and a closed top band turns every larger job into a flagged estimate.
   */
  topBandClosed: boolean;
}

/**
 * Split one pasted row into cells.
 *
 * The delimiter is decided per line, by precedence: a tab wins, then a run of two or
 * more spaces, and only a line with neither is split on commas. That order matters
 * because band labels contain commas — "$5,000-9,999" — so a tab-separated or
 * space-aligned paste must never be split on them, while a true CSV must be. A quoted
 * field keeps its commas either way.
 */
function splitRow(line: string): string[] {
  const byTab = line.includes('\t');
  const bySpaces = !byTab && /\S {2,}\S/.test(line);
  const byComma = !byTab && !bySpaces;
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted) {
      if ((byTab && ch === '\t') || (byComma && ch === ',')) {
        out.push(cur);
        cur = '';
        continue;
      }
      if (bySpaces && ch === ' ' && line[i + 1] === ' ') {
        out.push(cur);
        cur = '';
        while (line[i + 1] === ' ') i++;
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c !== '');
}

/** "$15,000-24,999", "15000 - 24999", "$500,000+", "100000 and above". */
export function parseBandLabel(raw: string): { minMinor: number; maxMinor: number | null } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const numbers = [...text.matchAll(/\$?\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  if (!numbers.length) return null;
  const openEnded = /\+|and\s+(above|over|up)|or\s+more/i.test(text);
  const min = Math.round(numbers[0]! * 100);
  if (openEnded || numbers.length === 1) return { minMinor: min, maxMinor: null };
  // The label's upper bound is inclusive of cents below the next dollar — "24,999"
  // means "up to 24,999.99" — so the exclusive bound is the next whole dollar.
  return { minMinor: min, maxMinor: Math.round(numbers[1]! * 100) + 100 };
}

/**
 * Parse a pasted rate grid.
 *
 * Expects a header row of term lengths and one row per band:
 *
 *     COST              12       24       36       48       60
 *     $5,000-9,999      .09590   .05016   .03514   .02769   .02324
 *     $10,000-14,999    .09156   .04753   .03301   .02577   .02144
 *
 * A cell that is blank, a dash, or a zero-like ".0000" is treated as NOT OFFERED and
 * no rate row is written for it — that is how the published sheet marks the 12- and
 * 60-month gaps on its smallest band.
 */
export function parseRateSheetPaste(text: string): ParsedRateSheet {
  const errors: string[] = [];
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cells = (line: string) => splitRow(line);

  let termMonths: number[] = [];
  const bands: ParsedRateBand[] = [];

  lines.forEach((line, i) => {
    const parts = cells(line);
    if (parts.length < 2) return;

    // The header is the first row whose cells read as term lengths. Found by shape
    // rather than by keyword, so "COST", "MONTHLY TERM" or a blank corner cell all
    // work.
    //
    // The corner cell is the subtle part. A trimmed line loses the leading blank, so
    // "  12  24  36" arrives as three cells with no label — and treating the first as
    // a label would drop the 12-month column and shift every factor one term to the
    // left. A bare integer in the corner is therefore read as a term, while a band
    // label (which always carries a $, a comma or a range) is not. A factor is always
    // written as a decimal, which is what keeps a band row out of this branch.
    if (!termMonths.length) {
      const plausible = (cell: string, n: number) =>
        Number.isInteger(n) && n >= 3 && n <= 120 && !cell.includes('.');
      const num = (cell: string) => Number(cell.replace(/[^\d]/g, ''));
      const cornerIsTerm = /^\d+$/.test(parts[0]!.trim()) && plausible(parts[0]!, num(parts[0]!));
      const cand = cornerIsTerm ? parts : parts.slice(1);
      if (cand.length >= 1 && cand.every((c) => plausible(c, num(c)))) {
        termMonths = cand.map(num);
        return;
      }
    }

    const bounds = parseBandLabel(parts[0]!);
    if (!bounds) return;
    if (!termMonths.length) {
      errors.push(`Line ${i + 1}: found a band before the row of term lengths.`);
      return;
    }

    const factors: Record<number, number> = {};
    parts.slice(1).forEach((cell, idx) => {
      const term = termMonths[idx];
      if (term == null) return;
      // A dash, an em dash, "n/a" or ".0000" all mean the lessor does not offer it.
      if (/^(-+|—|–|n\/?a)$/i.test(cell)) return;
      const value = Number(cell.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(value) || value <= 0) return;
      if (value >= 1) {
        errors.push(
          `Line ${i + 1}: ${cell} is not a payment factor — a factor is the payment per $1 financed, so it is below 1.`,
        );
        return;
      }
      factors[term] = value;
    });

    if (!Object.keys(factors).length) {
      errors.push(`Line ${i + 1}: no usable factors on this row.`);
      return;
    }
    bands.push({ label: parts[0]!.trim(), ...bounds, factors });
  });

  if (!termMonths.length)
    errors.push(
      'No row of term lengths found — the first row should read like: COST 12 24 36 48 60.',
    );
  if (!bands.length) errors.push('No amount bands found.');

  // Overlapping bands make which factor applies a matter of sort order, so they are
  // reported rather than silently resolved.
  const sorted = [...bands].sort((a, b) => a.minMinor - b.minMinor);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.maxMinor == null || cur.minMinor < prev.maxMinor) {
      if (prev.maxMinor !== null || i !== sorted.length - 1) {
        errors.push(`${prev.label} and ${cur.label} overlap — each amount must fall in one band.`);
      }
    }
  }

  return {
    termMonths,
    bands: sorted,
    errors,
    topBandClosed: sorted.length > 0 && sorted[sorted.length - 1]!.maxMinor != null,
  };
}

/* -------------------------------------------------------------------------- */
/* The published 2025 sheet                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ryan Capital's 2025 payment factors, transcribed from the RATES tab of
 * "2025 Ryan Capital Payment Calculator".
 *
 * Held in code only so the CRM can be seeded in one click on a fresh database.
 * After that the database is the source of truth and this constant is not read
 * again — next year's sheet is pasted in, not deployed.
 *
 * Two faithful details. The 3,000–4,999 band has no 12- or 60-month factor, matching
 * the ".0000" the workbook prints there. The top band is labelled 100,000–200,000 but
 * the workbook's own formula applies it up to 500,000, so it is stored open-ended
 * above 100,000 rather than pretending to a ceiling the sheet does not enforce.
 */
export const RYAN_CAPITAL_2025 = {
  name: 'Ryan Capital 2025',
  source: '2025 Ryan Capital Payment Calculator (RATES tab)',
  effectiveOn: '2025-01-01',
  termMonths: [12, 24, 36, 48, 60],
  bands: [
    {
      label: '$3,000-4,999',
      min: 3_000,
      max: 5_000,
      factors: { 24: 0.05622, 36: 0.04088, 48: 0.03334 },
    },
    {
      label: '$5,000-9,999',
      min: 5_000,
      max: 10_000,
      factors: { 12: 0.0959, 24: 0.05016, 36: 0.03514, 48: 0.02769, 60: 0.02324 },
    },
    {
      label: '$10,000-14,999',
      min: 10_000,
      max: 15_000,
      factors: { 12: 0.09156, 24: 0.04753, 36: 0.03301, 48: 0.02577, 60: 0.02144 },
    },
    {
      label: '$15,000-24,999',
      min: 15_000,
      max: 25_000,
      factors: { 12: 0.0907, 24: 0.04708, 36: 0.0327, 48: 0.02553, 60: 0.02124 },
    },
    {
      label: '$25,000-34,999',
      min: 25_000,
      max: 35_000,
      factors: { 12: 0.08984, 24: 0.04663, 36: 0.03239, 48: 0.02528, 60: 0.02104 },
    },
    {
      label: '$35,000-49,999',
      min: 35_000,
      max: 50_000,
      factors: { 12: 0.08932, 24: 0.04641, 36: 0.03223, 48: 0.02516, 60: 0.02094 },
    },
    {
      label: '$50,000-74,999',
      min: 50_000,
      max: 75_000,
      factors: { 12: 0.08889, 24: 0.04608, 36: 0.03197, 48: 0.02494, 60: 0.02073 },
    },
    {
      label: '$75,000-99,999',
      min: 75_000,
      max: 100_000,
      factors: { 12: 0.08846, 24: 0.04586, 36: 0.03182, 48: 0.02482, 60: 0.02063 },
    },
    {
      label: '$100,000 and above',
      min: 100_000,
      max: null,
      factors: { 12: 0.08802, 24: 0.04563, 36: 0.03166, 48: 0.02469, 60: 0.02053 },
    },
  ],
} as const;

/** Write a card from parsed or built-in data. Bands and rates are replaced wholesale. */
export async function writeRateCard(input: {
  cardId?: string;
  name: string;
  source?: string | null;
  effectiveOn: Date;
  notes?: string | null;
  active?: boolean;
  bands: Array<{
    label: string;
    minMinor: number;
    maxMinor: number | null;
    factors: Record<number, number>;
  }>;
  actorId?: string;
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    let cardId = input.cardId ?? null;
    if (cardId) {
      await tx.financeRateCard.update({
        where: { id: cardId },
        data: {
          name: input.name,
          source: input.source ?? null,
          effectiveOn: input.effectiveOn,
          notes: input.notes ?? null,
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      await tx.financeRateBand.deleteMany({ where: { cardId } });
    } else {
      const created = await tx.financeRateCard.create({
        data: {
          name: input.name,
          source: input.source ?? null,
          effectiveOn: input.effectiveOn,
          notes: input.notes ?? null,
          active: input.active ?? false,
          createdById: input.actorId ?? null,
        },
      });
      cardId = created.id;
    }

    const ordered = [...input.bands].sort((a, b) => a.minMinor - b.minMinor);
    for (let i = 0; i < ordered.length; i++) {
      const b = ordered[i]!;
      await tx.financeRateBand.create({
        data: {
          cardId,
          label: b.label,
          minMinor: b.minMinor,
          maxMinor: b.maxMinor,
          sortOrder: i,
          rates: {
            create: Object.entries(b.factors)
              .filter(([, f]) => Number.isFinite(Number(f)) && Number(f) > 0)
              .map(([term, f]) => ({ termMonths: Number(term), factor: Number(f) })),
          },
        },
      });
    }
    return cardId;
  });
}

/** Seed the built-in 2025 sheet. Returns null when a card already exists. */
export async function seedBuiltInCard(actorId?: string): Promise<string | null> {
  const existing = await prisma.financeRateCard.count();
  if (existing > 0) return null;
  return writeRateCard({
    name: RYAN_CAPITAL_2025.name,
    source: RYAN_CAPITAL_2025.source,
    effectiveOn: new Date(`${RYAN_CAPITAL_2025.effectiveOn}T00:00:00Z`),
    active: true,
    actorId,
    bands: RYAN_CAPITAL_2025.bands.map((b) => ({
      label: b.label,
      minMinor: b.min * 100,
      maxMinor: b.max == null ? null : b.max * 100,
      factors: b.factors as Record<number, number>,
    })),
  });
}

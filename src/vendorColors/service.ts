/**
 * Vendor colours — resolving what a line may be coloured, and validating what it was.
 *
 * The vendor owns the chart (VendorColorPalette), a product says how many colours it
 * takes (ProductColorSpec, 1–7), and a selection is a list of named colours from that
 * chart in slot order. Everything a caller needs is here so the proposal editor, the
 * Bill of Materials and the admin screen agree on what a valid selection is.
 *
 * Selections are stored DENORMALISED — the colour's name and vendor code are copied
 * onto the line beside its id. A BOM printed last spring must still read the same
 * after the vendor renames "Royal Blue" to "Royal Blue II", and a discontinued colour
 * must not blank out on a historic sheet. The id is kept for reporting and for
 * re-validation while the proposal is still a draft.
 *
 * Nothing here touches the Goldberg powder-coat chart, which keeps its own brand+code
 * path (see routes/formulas.ts → Paint colour chart).
 */

import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';

/** The ceiling the business set. Also enforced by a CHECK constraint on the table. */
export const MAX_COLOR_SLOTS = 7;

export interface ColorPick {
  /** 1-based slot. Slots may be skipped: [1,3] is a legal partial selection. */
  slot: number;
  colorId: string;
  name: string;
  vendorCode: string | null;
  /** The colour's own upcharge as it stood when chosen, in minor units. */
  upchargeMinor: number;
}

export interface ResolvedColorSpec {
  specId: string;
  slotCount: number;
  required: boolean;
  slotUpchargeMinor: number;
  /** Labels in slot order; entries may be blank, in which case use slotLabel(). */
  slotLabels: string[];
  notes: string | null;
  palette: {
    id: string;
    name: string;
    finishType: string;
    manufacturerId: string;
    manufacturerName: string;
  };
  /** Selectable colours, in the vendor's own order. Inactive ones are excluded. */
  colors: { id: string; name: string; vendorCode: string | null; upchargeMinor: number }[];
}

/** "Colour 3" unless the spec named that slot. */
export function slotLabel(spec: ResolvedColorSpec, slot: number): string {
  const named = spec.slotLabels[slot - 1];
  return named && named.trim() ? named.trim() : `Colour ${slot}`;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : [];

type SpecRow = {
  id: string;
  slotCount: number;
  required: boolean;
  slotUpchargeMinor: number | null;
  slotLabels: unknown;
  notes: string | null;
  palette: {
    id: string;
    name: string;
    finishType: string;
    active: boolean;
    manufacturer: { id: string; name: string };
    colors: {
      id: string;
      name: string;
      vendorCode: string | null;
      upchargeMinor: number | null;
      active: boolean;
      sortOrder: number;
    }[];
  };
};

const SPEC_INCLUDE = {
  palette: {
    include: {
      manufacturer: { select: { id: true, name: true } },
      colors: { orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }] },
    },
  },
};

function shape(row: SpecRow): ResolvedColorSpec {
  return {
    specId: row.id,
    slotCount: Math.min(Math.max(row.slotCount, 1), MAX_COLOR_SLOTS),
    required: row.required,
    slotUpchargeMinor: row.slotUpchargeMinor ?? 0,
    slotLabels: asStringArray(row.slotLabels),
    notes: row.notes,
    palette: {
      id: row.palette.id,
      name: row.palette.name,
      finishType: String(row.palette.finishType),
      manufacturerId: row.palette.manufacturer.id,
      manufacturerName: row.palette.manufacturer.name,
    },
    colors: row.palette.colors
      .filter((c) => c.active)
      .map((c) => ({
        id: c.id,
        name: c.name,
        vendorCode: c.vendorCode,
        upchargeMinor: c.upchargeMinor ?? 0,
      })),
  };
}

/**
 * The colour spec for one line, or null if the product takes no colour choice.
 *
 * A catalog product's own spec wins over one keyed on its part number, so a
 * product-level rule cannot be silently overridden by a SKU row someone typed
 * later. Part numbers are matched case-insensitively — BOM lines carry them as
 * typed, and "r-ssg-1010clm" is the same pad as "R-SSG-1010CLM".
 */
export async function specForLine(line: {
  productId?: string | null;
  sku?: string | null;
}): Promise<ResolvedColorSpec | null> {
  if (line.productId) {
    const byProduct = (await prisma.productColorSpec.findUnique({
      where: { productId: line.productId },
      include: SPEC_INCLUDE,
    })) as SpecRow | null;
    if (byProduct) return shape(byProduct);
  }
  const sku = (line.sku ?? '').trim();
  if (!sku) return null;
  const bySku = (await prisma.productColorSpec.findFirst({
    where: { sku: { equals: sku, mode: 'insensitive' } },
    include: SPEC_INCLUDE,
  })) as SpecRow | null;
  return bySku ? shape(bySku) : null;
}

/**
 * Specs for a whole sheet in two queries rather than two per line.
 *
 * Keyed by productId first, then by upper-cased sku — look a line up the same way:
 * `map.get(line.productId ?? '') ?? map.get((line.sku ?? '').toUpperCase())`.
 */
export async function specsForLines(
  lines: { productId?: string | null; sku?: string | null }[],
): Promise<Map<string, ResolvedColorSpec>> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))] as string[];
  const skus = [...new Set(lines.map((l) => (l.sku ?? '').trim()).filter(Boolean))];
  const out = new Map<string, ResolvedColorSpec>();
  if (!productIds.length && !skus.length) return out;

  const rows = (await prisma.productColorSpec.findMany({
    where: {
      OR: [
        ...(productIds.length ? [{ productId: { in: productIds } }] : []),
        ...(skus.length ? [{ sku: { in: skus, mode: 'insensitive' as const } }] : []),
      ],
    },
    include: SPEC_INCLUDE,
  })) as SpecRow[];

  for (const row of rows) {
    const spec = shape(row);
    const r = row as SpecRow & { productId: string | null; sku: string | null };
    if (r.productId) out.set(r.productId, spec);
    else if (r.sku) out.set(r.sku.trim().toUpperCase(), spec);
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Untrusted selection → the picks that may be stored.
 *
 * Rejects rather than repairs, with one exception: a pick whose colour is absent
 * from the input is treated as "not chosen yet" and dropped, because a slot left
 * blank is the normal state of a proposal written before the customer decided.
 *
 * Refuses a colour that is not on the product's palette, a slot outside 1…slotCount,
 * two picks for one slot, and a discontinued colour. Names and codes are taken from
 * the palette, never from the caller — the client cannot rename a colour by posting.
 */
export function normalizePicks(
  spec: ResolvedColorSpec,
  input: unknown,
  opts: { requireComplete?: boolean } = {},
): ColorPick[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new ValidationError('Colour selections must be a list.');
  if (input.length > MAX_COLOR_SLOTS)
    throw new ValidationError(`A product takes at most ${MAX_COLOR_SLOTS} colours.`);

  const byId = new Map(spec.colors.map((c) => [c.id, c]));
  const seen = new Set<number>();
  const picks: ColorPick[] = [];

  for (const raw of input) {
    if (!isRecord(raw)) throw new ValidationError('Each colour selection must be an object.');
    const colorId = typeof raw.colorId === 'string' ? raw.colorId.trim() : '';
    const slot = Number(raw.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > spec.slotCount)
      throw new ValidationError(
        `This product takes ${spec.slotCount} colour${spec.slotCount === 1 ? '' : 's'}, so there is no slot ${raw.slot}.`,
      );
    if (!colorId) continue; // Slot cleared: not an error, just undecided.
    if (seen.has(slot))
      throw new ValidationError(`Two colours were given for ${slotLabel(spec, slot)}.`);
    const color = byId.get(colorId);
    if (!color)
      throw new ValidationError(
        `That colour is not on ${spec.palette.manufacturerName}'s ${spec.palette.name}. Discontinued colours cannot be chosen on a new line.`,
      );
    seen.add(slot);
    picks.push({
      slot,
      colorId: color.id,
      name: color.name,
      vendorCode: color.vendorCode,
      upchargeMinor: color.upchargeMinor,
    });
  }

  if ((opts.requireComplete ?? spec.required) && picks.length < spec.slotCount) {
    const missing = [];
    for (let s = 1; s <= spec.slotCount; s += 1) if (!seen.has(s)) missing.push(slotLabel(spec, s));
    throw new ValidationError(`Choose a colour for ${missing.join(', ')}.`);
  }

  picks.sort((a, b) => a.slot - b.slot);
  return picks;
}

/** Picks read back off a stored line. Shape-checked, never re-priced. */
export function readPicks(stored: unknown): ColorPick[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(isRecord)
    .map((p) => ({
      slot: Number(p.slot) || 0,
      colorId: typeof p.colorId === 'string' ? p.colorId : '',
      name: typeof p.name === 'string' ? p.name : '',
      vendorCode: typeof p.vendorCode === 'string' ? p.vendorCode : null,
      upchargeMinor: Number(p.upchargeMinor) || 0,
    }))
    .filter((p) => p.slot > 0 && p.name)
    .sort((a, b) => a.slot - b.slot);
}

/**
 * What the colour choice adds to one unit, in minor units.
 *
 * Each chosen slot carries the spec's per-slot fabrication upcharge plus whatever
 * that colour costs. An unchosen slot adds nothing — a colour decided later is
 * priced later, and quoting a fabrication charge for a panel nobody has specified
 * would have to be refunded.
 */
export function colorUpchargeMinor(
  spec: Pick<ResolvedColorSpec, 'slotUpchargeMinor'>,
  picks: ColorPick[],
): number {
  return picks.reduce((sum, p) => sum + p.upchargeMinor + spec.slotUpchargeMinor, 0);
}

/**
 * Picks → one line of text for a document.
 *
 * The vendor's own code is included only where it belongs: on a Bill of Materials the
 * vendor reads, never on a proposal the customer reads.
 */
export function describePicks(
  picks: ColorPick[],
  opts: { withVendorCode?: boolean; spec?: ResolvedColorSpec } = {},
): string {
  return picks
    .map((p) => {
      const label = opts.spec ? slotLabel(opts.spec, p.slot) : `Colour ${p.slot}`;
      const code = opts.withVendorCode && p.vendorCode ? ` (${p.vendorCode})` : '';
      return `${label}: ${p.name}${code}`;
    })
    .join(' · ');
}

/**
 * Colours to copy onto a procurement line when an order is created from an accepted
 * proposal. The proposal item is the source of truth; a line the customer never chose
 * a colour for starts blank and is filled in on the sheet.
 */
export function picksFromProposalItem(item: unknown): ColorPick[] {
  if (!isRecord(item)) return [];
  return readPicks(item.colorPicks);
}

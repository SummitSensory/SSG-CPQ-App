import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import { areaLabel, colorAreasOf, isAreaKey, isPartPattern, normalizeSkus } from './colorAreas.js';

/**
 * Administration → Orders → Portal colour areas: which catalog parts each portal
 * colour area paints.
 *
 * The list of areas is not configured anywhere — it is whatever the portal has
 * actually asked customers, read out of every COLOR answer on record, plus any key
 * already mapped (so a mapping made ahead of the portal using it does not vanish from
 * the screen). A new area the portal starts asking about therefore appears here on
 * its own, flagged unmapped, the first time a customer answers it.
 */

export interface AreaSample {
  brand: string;
  code: string;
  /** How many orders picked this. */
  count: number;
}

export interface MappedPart {
  /** A part number, or a pattern with `*` (e.g. R-SSG-*CLM* for every mat size). */
  sku: string;
  /** The catalog description, or null when the part number is not in the catalog. */
  name: string | null;
  /** Which piece (colour-spec slot) of a multi-piece part; null = the whole part. */
  piece: number | null;
}

/** A part as the screen sends it: part number (or pattern) and optional piece. */
export interface PartInput {
  sku: string;
  piece?: number | null;
}

export const MAX_PIECE = 7; // a colour spec takes at most 7 colours (MAX_COLOR_SLOTS)

export interface ColorAreaRow {
  areaKey: string;
  label: string;
  /** Orders whose colour answers include this area. */
  orderCount: number;
  /** The most common picks, most common first. */
  samples: AreaSample[];
  parts: MappedPart[];
}

const SAMPLE_LIMIT = 4;

/** Catalog descriptions for part numbers, keyed by upper-cased part number. */
async function catalogNames(
  skusIn: readonly string[],
): Promise<Map<string, { part: string; name: string }>> {
  const out = new Map<string, { part: string; name: string }>();
  // A pattern names no single catalog row.
  const skus = skusIn.filter((s) => !isPartPattern(s));
  if (!skus.length) return out;
  const rows = await prisma.sku.findMany({
    where: { OR: skus.map((s) => ({ part: { equals: s, mode: 'insensitive' as const } })) },
    select: { part: true, description: true },
  });
  for (const r of rows) out.set(r.part.toUpperCase(), { part: r.part, name: r.description });
  return out;
}

export async function listColorAreas(): Promise<ColorAreaRow[]> {
  const [items, mappings] = await Promise.all([
    prisma.orderPortalItem.findMany({
      where: { kind: 'COLOR' },
      select: { orderId: true, answers: true },
    }),
    prisma.portalColorAreaMapping.findMany({
      select: { areaKey: true, sku: true, piece: true },
      orderBy: [{ areaKey: 'asc' }, { sku: 'asc' }],
    }),
  ]);

  const used = new Map<string, { orders: Set<string>; picks: Map<string, AreaSample> }>();
  for (const item of items) {
    for (const p of colorAreasOf(item.answers)) {
      const u = used.get(p.areaKey) ?? { orders: new Set<string>(), picks: new Map() };
      u.orders.add(item.orderId);
      const k = `${p.brand.toLowerCase()}|${p.code.toLowerCase()}`;
      const s = u.picks.get(k) ?? { brand: p.brand, code: p.code, count: 0 };
      s.count += 1;
      u.picks.set(k, s);
      used.set(p.areaKey, u);
    }
  }

  const mapped = new Map<string, Array<{ sku: string; piece: number | null }>>();
  for (const m of mappings) {
    const list = mapped.get(m.areaKey) ?? [];
    list.push({ sku: m.sku, piece: m.piece ?? null });
    mapped.set(m.areaKey, list);
  }
  const names = await catalogNames([...new Set(mappings.map((m) => m.sku))]);

  const keys = [...new Set([...used.keys(), ...mapped.keys()])].sort((a, b) => a.localeCompare(b));
  return keys.map((areaKey) => {
    const u = used.get(areaKey);
    return {
      areaKey,
      label: areaLabel(areaKey),
      orderCount: u ? u.orders.size : 0,
      samples: u
        ? [...u.picks.values()]
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
            .slice(0, SAMPLE_LIMIT)
        : [],
      parts: (mapped.get(areaKey) ?? []).map((m) => ({
        sku: m.sku,
        name: names.get(m.sku.toUpperCase())?.name ?? null,
        piece: m.piece,
      })),
    };
  });
}

export interface SaveAreaResult {
  areaKey: string;
  parts: MappedPart[];
  added: string[];
  removed: string[];
  /** Saved, but not in the catalog — shown so a typo is noticed rather than trusted. Patterns are never listed. */
  unknownSkus: string[];
}

function normalizeParts(input: readonly (string | PartInput)[]): PartInput[] {
  const seen = new Set<string>();
  const out: PartInput[] = [];
  for (const raw of input) {
    const sku = String(typeof raw === 'string' ? raw : (raw.sku ?? '')).trim();
    if (!sku) continue;
    const k = sku.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // A bare part number (an older screen) says nothing about pieces: undefined
    // means "keep whatever piece is stored", never "clear it".
    const pieceRaw = typeof raw === 'string' ? undefined : raw.piece;
    const piece =
      pieceRaw === undefined
        ? undefined
        : pieceRaw == null || (pieceRaw as unknown) === ''
          ? null
          : Number(pieceRaw);
    if (piece != null && (!Number.isInteger(piece) || piece < 1 || piece > MAX_PIECE)) {
      throw new ValidationError(`Piece for ${sku} must be a whole number from 1 to ${MAX_PIECE}.`);
    }
    // A pattern must start with a real prefix (at least 3 characters before the
    // first *), so it can't sweep in unrelated parts the way "R*" or "*A*" would.
    if (isPartPattern(sku) && !/^[^*]{3,}/.test(sku)) {
      throw new ValidationError(
        `"${sku}" is too broad. A pattern must start with at least 3 characters, e.g. R-SSG-*CLM*.`,
      );
    }
    out.push({ sku, piece });
  }
  return out;
}

/**
 * Replace the parts an area paints. A part number is stored in the catalog's own
 * spelling when the catalog has it, so the screen and the audit read consistently;
 * one the catalog does not have is still saved (a hand-added BOM line can carry a
 * part the catalog never had) and reported back as unknown.
 */
export async function saveColorArea(
  areaKey: string,
  partsIn: readonly (string | PartInput)[],
  actorId: string,
): Promise<SaveAreaResult> {
  if (!isAreaKey(areaKey)) {
    throw new ValidationError(
      `"${areaKey}" is not a portal colour area. Area keys look like structure_frame_paint.legs.`,
    );
  }
  const wanted = normalizeParts(partsIn);
  const names = await catalogNames(wanted.map((p) => p.sku));
  // Catalog spelling for a real part; a pattern is stored upper-cased, as typed.
  const canonical = wanted.map((p) => ({
    sku: isPartPattern(p.sku)
      ? p.sku.toUpperCase()
      : (names.get(p.sku.toUpperCase())?.part ?? p.sku),
    piece: p.piece,
  }));
  // normalizeSkus is still the single rule for "same part number".
  const canonicalSkus = normalizeSkus(canonical.map((p) => p.sku));

  const existing = await prisma.portalColorAreaMapping.findMany({
    where: { areaKey },
    select: { id: true, sku: true, piece: true },
  });
  const keep = new Map(canonical.map((p) => [p.sku.toUpperCase(), p]));
  const had = new Map(existing.map((e) => [e.sku.toUpperCase(), e]));
  const removedRows = existing.filter((e) => !keep.has(e.sku.toUpperCase()));
  const added = canonical.filter((p) => !had.has(p.sku.toUpperCase()));
  const repieced = existing.filter((e) => {
    const next = keep.get(e.sku.toUpperCase());
    return (
      next !== undefined && next.piece !== undefined && (next.piece ?? null) !== (e.piece ?? null)
    );
  });

  if (removedRows.length || added.length || repieced.length) {
    await prisma.$transaction([
      prisma.portalColorAreaMapping.deleteMany({
        where: { id: { in: removedRows.map((r) => r.id) } },
      }),
      prisma.portalColorAreaMapping.createMany({
        data: added.map((p) => ({
          areaKey,
          sku: p.sku,
          piece: p.piece ?? null,
          createdById: actorId,
        })),
        skipDuplicates: true,
      }),
      ...repieced.map((e) =>
        prisma.portalColorAreaMapping.update({
          where: { id: e.id },
          data: { piece: keep.get(e.sku.toUpperCase())?.piece ?? null },
        }),
      ),
    ]);
    await recordAudit({
      actorId,
      action: 'portal.color-area.map',
      entity: 'PortalColorAreaMapping',
      entityId: areaKey,
      details: {
        added: added.map((p) => (p.piece ? `${p.sku} (piece ${p.piece})` : p.sku)),
        removed: removedRows.map((r) => r.sku),
        repieced: repieced.map(
          (e) =>
            `${e.sku}: piece ${e.piece ?? '—'} → ${keep.get(e.sku.toUpperCase())?.piece ?? '—'}`,
        ),
        skus: canonicalSkus,
      },
    });
  }

  return {
    areaKey,
    parts: canonical.map((p) => ({
      sku: p.sku,
      name: names.get(p.sku.toUpperCase())?.name ?? null,
      piece: p.piece !== undefined ? p.piece : (had.get(p.sku.toUpperCase())?.piece ?? null),
    })),
    added: added.map((p) => p.sku),
    removed: removedRows.map((r) => r.sku),
    unknownSkus: canonical
      .map((p) => p.sku)
      .filter((s) => !isPartPattern(s) && !names.has(s.toUpperCase())),
  };
}

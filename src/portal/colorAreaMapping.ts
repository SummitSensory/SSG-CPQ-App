import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import { areaLabel, colorAreasOf, isAreaKey, normalizeSkus } from './colorAreas.js';

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
  sku: string;
  /** The catalog description, or null when the part number is not in the catalog. */
  name: string | null;
}

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
  skus: readonly string[],
): Promise<Map<string, { part: string; name: string }>> {
  const out = new Map<string, { part: string; name: string }>();
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
      select: { areaKey: true, sku: true },
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

  const mapped = new Map<string, string[]>();
  for (const m of mappings) {
    const list = mapped.get(m.areaKey) ?? [];
    list.push(m.sku);
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
      parts: (mapped.get(areaKey) ?? []).map((sku) => ({
        sku,
        name: names.get(sku.toUpperCase())?.name ?? null,
      })),
    };
  });
}

export interface SaveAreaResult {
  areaKey: string;
  parts: MappedPart[];
  added: string[];
  removed: string[];
  /** Saved, but not in the catalog — shown so a typo is noticed rather than trusted. */
  unknownSkus: string[];
}

/**
 * Replace the parts an area paints. A part number is stored in the catalog's own
 * spelling when the catalog has it, so the screen and the audit read consistently;
 * one the catalog does not have is still saved (a hand-added BOM line can carry a
 * part the catalog never had) and reported back as unknown.
 */
export async function saveColorArea(
  areaKey: string,
  skus: readonly string[],
  actorId: string,
): Promise<SaveAreaResult> {
  if (!isAreaKey(areaKey)) {
    throw new ValidationError(
      `"${areaKey}" is not a portal colour area. Area keys look like structure_frame_paint.legs.`,
    );
  }
  const wanted = normalizeSkus(skus);
  const names = await catalogNames(wanted);
  const canonical = normalizeSkus(wanted.map((s) => names.get(s.toUpperCase())?.part ?? s));

  const existing = await prisma.portalColorAreaMapping.findMany({
    where: { areaKey },
    select: { id: true, sku: true },
  });
  const keep = new Set(canonical.map((s) => s.toUpperCase()));
  const had = new Set(existing.map((e) => e.sku.toUpperCase()));
  const removedRows = existing.filter((e) => !keep.has(e.sku.toUpperCase()));
  const added = canonical.filter((s) => !had.has(s.toUpperCase()));

  if (removedRows.length || added.length) {
    await prisma.$transaction([
      prisma.portalColorAreaMapping.deleteMany({
        where: { id: { in: removedRows.map((r) => r.id) } },
      }),
      prisma.portalColorAreaMapping.createMany({
        data: added.map((sku) => ({ areaKey, sku, createdById: actorId })),
        skipDuplicates: true,
      }),
    ]);
    await recordAudit({
      actorId,
      action: 'portal.color-area.map',
      entity: 'PortalColorAreaMapping',
      entityId: areaKey,
      details: { added, removed: removedRows.map((r) => r.sku), skus: canonical },
    });
  }

  return {
    areaKey,
    parts: canonical.map((sku) => ({ sku, name: names.get(sku.toUpperCase())?.name ?? null })),
    added,
    removed: removedRows.map((r) => r.sku),
    unknownSkus: canonical.filter((s) => !names.has(s.toUpperCase())),
  };
}

/**
 * Portal colour coverage report — the production check from
 * docs/audits/2026-10-08-colour-and-full-app-audit.md ("Production check").
 *
 * Which BOM parts each portal colour area paints lives only in the database
 * (Administration → Orders → Portal colour areas). An area with nothing mapped still
 * reviews cleanly but colours nothing, so this report lists, for every area the
 * portal can write (src/portal/knownAreas.ts):
 *   - the parts mapped to it, and any mapped part number the catalog doesn't have;
 *   - how many orders have answered it;
 * then any area answered or mapped that the portal list doesn't know, and whether
 * each active vinyl palette carries the portal's 14 vinyl names.
 *
 * Read-only — it never writes. Run with:  pnpm db:report:color-coverage
 * Exits 1 when an area is unmapped or a vinyl name is missing, so it can gate a check.
 */
import { PrismaClient } from '@prisma/client';
import { colorAreasOf, isPartPattern } from '../src/portal/colorAreas.js';
import { KNOWN_PORTAL_AREAS, knownAreaKeys, PORTAL_VINYL_NAMES } from '../src/portal/knownAreas.js';

const prisma = new PrismaClient();

async function main() {
  const [items, mappings, vinylPalettes] = await Promise.all([
    prisma.orderPortalItem.findMany({
      where: { kind: 'COLOR' },
      select: { orderId: true, answers: true },
    }),
    prisma.portalColorAreaMapping.findMany({
      select: { areaKey: true, sku: true, piece: true },
      orderBy: [{ areaKey: 'asc' }, { sku: 'asc' }],
    }),
    prisma.vendorColorPalette.findMany({
      where: { finishType: 'VINYL', active: true },
      select: {
        name: true,
        manufacturer: { select: { name: true } },
        colors: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    }),
  ]);

  const answered = new Map<string, Set<string>>();
  for (const item of items) {
    for (const p of colorAreasOf(item.answers)) {
      const key = p.areaKey.toLowerCase();
      const set = answered.get(key) ?? new Set<string>();
      set.add(item.orderId);
      answered.set(key, set);
    }
  }

  const mapped = new Map<string, Array<{ sku: string; piece: number | null }>>();
  for (const m of mappings) {
    const key = m.areaKey.trim().toLowerCase();
    const list = mapped.get(key) ?? [];
    list.push({ sku: m.sku, piece: m.piece ?? null });
    mapped.set(key, list);
  }

  const plainSkus = [...new Set(mappings.map((m) => m.sku).filter((s) => !isPartPattern(s)))];
  const inCatalog = new Set(
    (
      await prisma.sku.findMany({
        where: {
          OR: plainSkus.map((s) => ({ part: { equals: s, mode: 'insensitive' as const } })),
        },
        select: { part: true },
      })
    ).map((r) => r.part.toUpperCase()),
  );

  const known = knownAreaKeys();
  const unmapped: string[] = [];
  console.log(`Portal colour areas (${known.length} the portal can write)\n`);
  for (const [input] of Object.entries(KNOWN_PORTAL_AREAS)) {
    for (const key of known.filter((k) => k.startsWith(`${input}.`))) {
      const parts = mapped.get(key) ?? [];
      const orders = answered.get(key)?.size ?? 0;
      if (!parts.length) unmapped.push(key);
      const shown = parts
        .map((p) => {
          const piece = p.piece ? ` (piece ${p.piece})` : '';
          const flag =
            !isPartPattern(p.sku) && !inCatalog.has(p.sku.toUpperCase()) ? ' [not in catalog]' : '';
          return `${p.sku}${piece}${flag}`;
        })
        .join(', ');
      console.log(
        `  ${parts.length ? 'ok      ' : 'UNMAPPED'}  ${key.padEnd(42)} ${String(orders).padStart(3)} order(s)  ${shown}`,
      );
    }
  }

  const knownSet = new Set(known);
  const strays = [...new Set([...answered.keys(), ...mapped.keys()])]
    .filter((k) => !knownSet.has(k))
    .sort();
  if (strays.length) {
    console.log('\nAreas answered or mapped that the portal list does not know:');
    for (const k of strays) {
      console.log(
        `  ${k.padEnd(50)} ${answered.get(k)?.size ?? 0} order(s), ${mapped.get(k)?.length ?? 0} part(s) mapped`,
      );
    }
  }

  console.log(`\nActive vinyl palettes (portal offers ${PORTAL_VINYL_NAMES.length} names)`);
  const vinylGaps: string[] = [];
  if (!vinylPalettes.length) {
    console.log('  NONE — vinyl answers will print as "Vinyl <name>" with no vendor code.');
    vinylGaps.push('no active vinyl palette');
  }
  for (const pal of vinylPalettes) {
    const have = new Set(pal.colors.map((c) => c.name.trim().toLowerCase()));
    const missing = PORTAL_VINYL_NAMES.filter((n) => !have.has(n.toLowerCase()));
    const label = `${pal.manufacturer.name} — ${pal.name}`;
    if (missing.length) vinylGaps.push(label);
    console.log(
      `  ${missing.length ? 'MISSING ' : 'ok      '}  ${label}${missing.length ? `: ${missing.join(', ')}` : ''}`,
    );
  }

  console.log(
    `\nSummary: ${unmapped.length} unmapped area(s), ${strays.length} unknown area(s), ${vinylGaps.length} vinyl palette gap(s).`,
  );
  if (unmapped.length || vinylGaps.length) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());

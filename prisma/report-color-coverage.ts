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
 *   - a part mapped as piece N whose colour spec takes fewer than N colours (a review
 *     then leaves that whole line untouched, so even the other pieces are lost);
 * then any area answered or mapped that the portal list doesn't know, and whether
 * each active vinyl palette carries the portal's 14 vinyl names. Areas the portal has
 * retired (RETIRED_PORTAL_AREAS) are listed as "retired" and need no mapping.
 *
 * Read-only — it never writes. Run with:  pnpm db:report:color-coverage
 * Exits 1 when a live area is unmapped, a piece exceeds its spec, or a vinyl name is
 * missing, so it can gate a check.
 */
import { PrismaClient } from '@prisma/client';
import { colorAreasOf, isPartPattern } from '../src/portal/colorAreas.js';
import {
  KNOWN_PORTAL_AREAS,
  knownAreaKeys,
  PORTAL_VINYL_NAMES,
  RETIRED_PORTAL_AREAS,
} from '../src/portal/knownAreas.js';

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

  // Colour-spec slot counts for parts mapped by piece, looked up the way the BOM
  // does: the catalog product's own spec first, then one keyed on the part number.
  const pieceSkus = [
    ...new Set(mappings.filter((m) => m.piece != null).map((m) => m.sku.toUpperCase())),
  ];
  const slotsOf = new Map<string, number>();
  if (pieceSkus.length) {
    const ci = (s: string) => ({ equals: s, mode: 'insensitive' as const });
    const products = await prisma.product.findMany({
      where: { OR: pieceSkus.map((s) => ({ sku: ci(s) })) },
      select: { id: true, sku: true },
    });
    const specs = await prisma.productColorSpec.findMany({
      where: {
        palette: { active: true },
        OR: [
          { productId: { in: products.map((p) => p.id) } },
          ...pieceSkus.map((s) => ({ sku: ci(s) })),
        ],
      },
      select: { productId: true, sku: true, slotCount: true },
    });
    for (const sku of pieceSkus) {
      const pid = products.find((p) => (p.sku ?? '').toUpperCase() === sku)?.id;
      const spec =
        (pid && specs.find((x) => x.productId === pid)) ||
        specs.find((x) => (x.sku ?? '').toUpperCase() === sku);
      if (spec) slotsOf.set(sku, spec.slotCount);
    }
  }

  const known = knownAreaKeys();
  const unmapped: string[] = [];
  const retiredUnmapped: string[] = [];
  const pieceProblems: string[] = [];
  console.log(`Portal colour areas (${known.length} the portal can write)\n`);
  for (const [input] of Object.entries(KNOWN_PORTAL_AREAS)) {
    for (const key of known.filter((k) => k.startsWith(`${input}.`))) {
      const parts = mapped.get(key) ?? [];
      const orders = answered.get(key)?.size ?? 0;
      const retired = RETIRED_PORTAL_AREAS.has(key);
      if (!parts.length) (retired ? retiredUnmapped : unmapped).push(key);
      let badPiece = false;
      const shown = parts
        .map((p) => {
          const piece = p.piece ? ` (piece ${p.piece})` : '';
          const flag =
            !isPartPattern(p.sku) && !inCatalog.has(p.sku.toUpperCase()) ? ' [not in catalog]' : '';
          const slots = p.piece ? slotsOf.get(p.sku.toUpperCase()) : undefined;
          const tooFew = slots !== undefined && p.piece !== null && p.piece > slots;
          if (tooFew) {
            badPiece = true;
            pieceProblems.push(
              `${key}: ${p.sku} piece ${p.piece}, but its colour spec takes ${slots}`,
            );
          }
          return `${p.sku}${piece}${flag}${tooFew ? ` [spec takes ${slots} colour(s)]` : ''}`;
        })
        .join(', ');
      const status = badPiece
        ? 'PIECE   '
        : parts.length
          ? 'ok      '
          : retired
            ? 'retired '
            : 'UNMAPPED';
      const note = retired && !parts.length ? 'no longer asked by the portal' : '';
      console.log(
        `  ${status}  ${key.padEnd(42)} ${String(orders).padStart(3)} order(s)  ${shown || note}`,
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
    `\nSummary: ${unmapped.length} unmapped area(s), ${pieceProblems.length} piece/spec mismatch(es), ${strays.length} unknown area(s), ${vinylGaps.length} vinyl palette gap(s); ${retiredUnmapped.length} retired area(s) need nothing.`,
  );
  for (const p of pieceProblems) console.log(`  PIECE: ${p}`);
  if (unmapped.length || pieceProblems.length || vinylGaps.length) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());

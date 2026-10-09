/**
 * Map the Soft Steps side-panel colour (portal "Color 2") to the Bill of Materials.
 *
 * On 2026-10-05 the portal split Soft Steps (2 and 3 steps) into two vinyl colours.
 * Color 1 kept the old area key (soft_steps_2 / soft_steps_3), mapped to the whole
 * part; Color 2 (…_piece_2) was never mapped, so a side-panel pick reaches no line.
 * This maps both colours as PIECES of the part, the way Palisades (RPAL6868) and
 * Climb & Slide (RCLSD5630) are mapped:
 *
 *   soft_steps_2_mat.soft_steps_2         → RSS2432 piece 1
 *   soft_steps_2_mat.soft_steps_2_piece_2 → RSS2432 piece 2
 *   soft_steps_3_mat.soft_steps_3         → RSS2433 piece 1
 *   soft_steps_3_mat.soft_steps_3_piece_2 → RSS2433 piece 2
 *
 * A part whose colour spec takes ONE colour cannot receive a piece 2: the review
 * then leaves the whole line untouched (src/portal/colorAreas.ts), losing Color 1
 * too. So a 1-slot spec is raised to 2 slots, slot 2 labelled "Side Panel" if it
 * has no label. A part with no colour spec needs nothing — its pieces are written
 * as text ("Piece 1: … · Piece 2: …").
 *
 * DRY RUN by default: prints what it would change and writes nothing.
 *   pnpm db:map:soft-steps                                  (dry run)
 *   pnpm db:map:soft-steps --apply --actor=<admin email>    (writes, audited)
 * Safe to run twice: a second apply finds nothing to change.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { recordAudit } from '../src/lib/audit.js';
import { saveColorArea } from '../src/portal/colorAreaMapping.js';
import { PORTAL_VINYL_NAMES } from '../src/portal/knownAreas.js';

const PARTS = [
  {
    sku: 'RSS2432',
    color1: 'soft_steps_2_mat.soft_steps_2',
    color2: 'soft_steps_2_mat.soft_steps_2_piece_2',
  },
  {
    sku: 'RSS2433',
    color1: 'soft_steps_3_mat.soft_steps_3',
    color2: 'soft_steps_3_mat.soft_steps_3_piece_2',
  },
] as const;

const SIDE_PANEL = 'Side Panel';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ACTOR = args.find((a) => a.startsWith('--actor='))?.slice('--actor='.length);

type Part = { sku: string; piece: number | null };

async function mappedParts(areaKey: string): Promise<Part[]> {
  const rows = await prisma.portalColorAreaMapping.findMany({
    where: { areaKey: { equals: areaKey, mode: 'insensitive' } },
    select: { sku: true, piece: true },
    orderBy: { sku: 'asc' },
  });
  return rows.map((r) => ({ sku: r.sku, piece: r.piece ?? null }));
}

const show = (parts: Part[]): string =>
  parts.length
    ? parts.map((p) => (p.piece ? `${p.sku} (piece ${p.piece})` : p.sku)).join(', ')
    : '(nothing)';

/** The area's parts with `sku` set to `piece`; every other part on the area kept as is. */
function withPiece(parts: Part[], sku: string, piece: number): Part[] {
  const others = parts.filter((p) => p.sku.toUpperCase() !== sku.toUpperCase());
  return [...others, { sku, piece }];
}

const same = (a: Part[], b: Part[]): boolean =>
  show([...a].sort((x, y) => x.sku.localeCompare(y.sku))) ===
  show([...b].sort((x, y) => x.sku.localeCompare(y.sku)));

async function main() {
  let actorId = '';
  if (APPLY) {
    if (!ACTOR) throw new Error('--apply needs --actor=<email of the admin making the change>');
    const u = await prisma.user.findUnique({ where: { email: ACTOR }, select: { id: true } });
    if (!u) throw new Error(`No user with email ${ACTOR}`);
    actorId = u.id;
  }
  console.log(APPLY ? 'APPLYING changes.\n' : 'DRY RUN — nothing is written.\n');

  let changes = 0;
  for (const part of PARTS) {
    console.log(`${part.sku}`);

    // The spec the BOM would use: the catalog product's own first, then one keyed
    // on the part number (src/vendorColors/service.ts specForLine).
    const product = await prisma.product.findFirst({
      where: { sku: { equals: part.sku, mode: 'insensitive' } },
      select: { id: true },
    });
    const spec =
      (product
        ? await prisma.productColorSpec.findUnique({
            where: { productId: product.id },
            include: { palette: { include: { colors: { select: { name: true } } } } },
          })
        : null) ??
      (await prisma.productColorSpec.findFirst({
        where: { sku: { equals: part.sku, mode: 'insensitive' } },
        include: { palette: { include: { colors: { select: { name: true } } } } },
      }));

    let raiseSlots = false;
    let labels: string[] = [];
    if (!spec || !spec.palette.active) {
      console.log(
        `  colour spec: ${spec ? `on "${spec.palette.name}", which is not offered (ignored)` : 'none'} — pieces are written as text; no spec change needed`,
      );
    } else {
      labels = Array.isArray(spec.slotLabels)
        ? spec.slotLabels.map((l) => (typeof l === 'string' ? l : ''))
        : [];
      const have = new Set(spec.palette.colors.map((c) => c.name.trim().toLowerCase()));
      const missing = PORTAL_VINYL_NAMES.filter((n) => !have.has(n.toLowerCase()));
      console.log(
        `  colour spec: ${spec.slotCount} slot(s) on "${spec.palette.name}"` +
          (missing.length
            ? ` — WARNING: chart lacks ${missing.join(', ')}; a pick of those leaves the line for staff to set`
            : ' — chart has all 14 portal vinyl names'),
      );
      if (spec.slotCount < 2) {
        raiseSlots = true;
        changes++;
        console.log(
          `  CHANGE spec: slots ${spec.slotCount} → 2${labels[1]?.trim() ? '' : `, slot 2 labelled "${SIDE_PANEL}"`}` +
            (spec.required
              ? ' (spec is marked required: proposals will ask for both colours)'
              : ''),
        );
      }
    }

    const c1Now = await mappedParts(part.color1);
    const c2Now = await mappedParts(part.color2);
    const c1Want = withPiece(c1Now, part.sku, 1);
    const c2Want = withPiece(c2Now, part.sku, 2);
    for (const [area, now, want] of [
      [part.color1, c1Now, c1Want],
      [part.color2, c2Now, c2Want],
    ] as const) {
      if (same(now, want)) console.log(`  ok       ${area}: ${show(now)}`);
      else {
        changes++;
        console.log(`  CHANGE   ${area}: ${show(now)}  →  ${show(want)}`);
      }
    }

    if (!APPLY) {
      console.log('');
      continue;
    }

    // Spec first: a piece 2 mapping onto a 1-slot spec would make a review leave the
    // whole line untouched, so the mapping never goes in ahead of the slot.
    if (raiseSlots && spec) {
      const nextLabels = [
        labels[0] ?? '',
        labels[1]?.trim() ? labels[1] : SIDE_PANEL,
        ...labels.slice(2),
      ];
      await prisma.productColorSpec.update({
        where: { id: spec.id },
        data: {
          slotCount: 2,
          slotLabels: nextLabels.some((l) => l.trim()) ? nextLabels : Prisma.DbNull,
        },
      });
      await recordAudit({
        actorId,
        action: 'vendorColor.spec.update',
        entity: 'ProductColorSpec',
        entityId: spec.id,
        details: { slotCount: 2, required: spec.required, reason: 'Soft Steps side-panel colour' },
      });
    }
    if (!same(c1Now, c1Want)) await saveColorArea(part.color1, c1Want, actorId);
    if (!same(c2Now, c2Want)) await saveColorArea(part.color2, c2Want, actorId);
    console.log('  applied\n');
  }

  console.log(
    changes
      ? APPLY
        ? `Done: ${changes} change(s) applied.`
        : `${changes} change(s) to make. Re-run with --apply --actor=<your email> to write them.`
      : 'Nothing to change.',
  );
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

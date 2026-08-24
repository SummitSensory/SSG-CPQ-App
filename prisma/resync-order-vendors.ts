import { PrismaClient } from '@prisma/client';
import { reassignSkuVendor } from '../src/handoff/vendorReassign.js';

/**
 * Bring every open order line onto the vendor its catalog record now names.
 *
 * Re-sourcing a part carries itself onto live orders from now on, but only at the
 * moment the catalog is edited. Anything re-pointed BEFORE that shipped is still
 * sitting on the old vendor's Bill of Materials, and re-saving the same manufacturer
 * is not a change, so nothing would fire. This is the one-off catch-up.
 *
 *   pnpm tsx --env-file=.env prisma/resync-order-vendors.ts
 *   pnpm tsx --env-file=.env prisma/resync-order-vendors.ts --apply
 *
 * Without --apply it only reports. Submitted sheets are never touched — those lines
 * are listed with the section that needs unlocking.
 */

const prisma = new PrismaClient();

const UNASSIGNED = 'Unassigned vendor';
const vendorOf = (v: string | null | undefined): string => (v && v.trim()) || UNASSIGNED;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const actorArg = process.argv.find((a) => a.startsWith('--actor='));

  // The move is written to each order's timeline, so it needs a person. An explicit
  // --actor=email wins; otherwise the longest-standing SYSTEM_ADMIN stands in.
  const actor = actorArg
    ? await prisma.user.findFirst({
        where: { email: actorArg.slice(8) },
        select: { id: true, email: true },
      })
    : await prisma.user.findFirst({
        where: { role: 'SYSTEM_ADMIN' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true },
      });
  if (!actor) {
    console.error('No user to attribute the change to. Pass --actor=you@summitsensory.com');
    process.exit(1);
  }

  const [lines, skus] = await Promise.all([
    prisma.procurementLine.findMany({ select: { sku: true, vendor: true } }),
    prisma.sku.findMany({ select: { part: true, manufacturer: true } }),
  ]);
  const catalogVendor = new Map(
    skus
      .filter((k) => (k.manufacturer ?? '').trim())
      .map((k) => [k.part.trim().toUpperCase(), (k.manufacturer as string).trim()]),
  );

  // One entry per part that is on an order under a vendor the catalog no longer names.
  const wrong = new Map<string, Set<string>>();
  for (const l of lines) {
    const part = (l.sku ?? '').trim();
    if (!part) continue;
    const should = catalogVendor.get(part.toUpperCase());
    if (!should) continue;
    const has = vendorOf(l.vendor);
    if (has.toLowerCase() === should.toLowerCase()) continue;
    const set = wrong.get(part) ?? new Set<string>();
    set.add(has);
    wrong.set(part, set);
  }

  if (!wrong.size) {
    console.log('Every order line already sits on the vendor its catalog record names.');
    return;
  }

  console.log(`${wrong.size} part(s) are on an order under the wrong vendor:\n`);
  for (const [part, from] of wrong) {
    console.log(`  ${part}: ${[...from].join(', ')} -> ${catalogVendor.get(part.toUpperCase())}`);
  }

  if (!apply) {
    console.log('\nNothing written. Re-run with --apply to move them.');
    return;
  }

  console.log(`\nMoving, as ${actor.email}…\n`);
  let moved = 0;
  const blocked: string[] = [];
  for (const part of wrong.keys()) {
    const result = await reassignSkuVendor(part, catalogVendor.get(part.toUpperCase()), actor.id);
    if (!result) continue;
    moved += result.moved;
    console.log(`  ${part}: ${result.moved} line(s) across ${result.orders} order(s)`);
    for (const s2 of result.skipped) blocked.push(`${s2.orderNumber} · ${s2.reason}`);
  }

  console.log(`\n${moved} line(s) moved.`);
  if (blocked.length) {
    console.log('\nLeft alone — these sheets are submitted:');
    for (const b of [...new Set(blocked)]) console.log(`  ${b}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

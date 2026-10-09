/**
 * List out the bundled H-1000 "Hardware Kit" line on active orders' Bills of Materials.
 *
 *   pnpm db:repair:hardware-kits                     # dry run: prints what would change
 *   pnpm db:repair:hardware-kits --commit            # applies it
 *   pnpm db:repair:hardware-kits --order SO-2026-000040 [--order ...] [--commit]
 *
 * Dry run is the default. Safe to re-run: a repaired order is skipped. Logic and the
 * skip rules live in src/handoff/kitRepair.ts.
 */
import { planKitRepairs, applyKitRepair } from '../src/handoff/kitRepair.js';
import { prisma } from '../src/lib/prisma.js';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const orderNumbers = argv.flatMap((a, i) => {
  const next = argv[i + 1];
  return a === '--order' && next ? [next] : [];
});

const money = (m: number | null) => (m == null ? '—' : `$${(m / 100).toFixed(2)}`);

async function main(): Promise<void> {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').host;
    } catch {
      return '(unparseable DATABASE_URL)';
    }
  })();
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} against ${host}\n`);

  const plans = await planKitRepairs({ orderNumbers });
  if (!plans.length) console.log('No order has a bundled H-1000 line.');
  let repaired = 0;
  for (const p of plans) {
    console.log(`${p.orderNumber} [${p.orderStatus}] kit vendor: ${p.kitVendor ?? 'Unassigned'}`);
    console.log(`  ${p.action.toUpperCase()}: ${p.reason}`);
    for (const w of p.warnings) console.log(`  WARNING: ${w}`);
    for (const l of p.lines)
      console.log(
        `    + ${l.sku.padEnd(12)} x${String(l.quantity).padStart(4)}  ${(l.vendor ?? 'Unassigned').padEnd(20)} ${money(l.unitCostMinor).padStart(9)}  ${l.name}`,
      );
    if (p.action === 'repair') console.log(`    - H-1000 Hardware Kit (deleted)`);
    if (COMMIT && p.action === 'repair') {
      const ok = await applyKitRepair(p);
      console.log(ok ? '  -> applied' : '  -> not applied (changed since planning)');
      if (ok) repaired += 1;
    }
    console.log('');
  }
  const todo = plans.filter((p) => p.action === 'repair').length;
  console.log(
    COMMIT
      ? `${repaired} order(s) repaired.`
      : `${todo} order(s) would be repaired. Nothing was changed. Re-run with --commit to apply.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

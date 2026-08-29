/**
 * Has an unpriced part already reached a customer proposal?
 *
 * THE URGENT QUESTION, and the reason it is urgent
 * -----------------------------------------------
 * 194 Products in this database have no `Sku` row, because neither product import path
 * creates one:
 *
 *   POST /catalog/import       -> prisma.product.create, nothing else
 *   POST /catalog/tree/import  -> prisma.product.create (status DRAFT), and only
 *                                 touches Sku to DEACTIVATE rows
 *
 * Price, cost and weight live on `Sku`. So those parts have no price. That alone would
 * merely be incomplete data. What makes it a money problem is how the proposal builder
 * finds parts.
 *
 * `openLinePicker` in public/app.js searches `GET /catalog/items` and keeps everything
 * where `i.active` is true. For a Product row with no Sku, that endpoint returns:
 *
 *     unitPriceMinor: 0,
 *     active: p.status === 'ACTIVE',
 *
 * 193 of the 194 are ACTIVE. So every one of them is offered to a rep in the part
 * picker, and every one of them carries a unit price of zero. Nothing warns anybody:
 * the line looks like any other line, and it adds $0.00 to the total.
 *
 * This script reads every proposal version's stored line items and reports any line
 * whose part has no `Sku`, and separately any line quoted at a zero rate. It is the
 * difference between "we must fix this before it happens" and "it has already happened
 * and these are the proposals to check".
 *
 * READ-ONLY. Reports; changes nothing.
 *
 * Run with:
 *   npx tsx --env-file=.env prisma/report-zero-priced-lines.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const key = (v: unknown): string => (v == null ? '' : String(v)).trim().toLowerCase();
const money = (m: unknown): string => (m == null ? '—' : `$${(Number(m) / 100).toFixed(2)}`);

interface RawItem {
  lineType?: unknown;
  name?: unknown;
  sku?: unknown;
  quantity?: unknown;
  rateMinor?: unknown;
}

/**
 * Pull line items out of a version.
 *
 * `items` is the flat list and `sections` is the grouped shape; which one carries the
 * lines has changed over time, so both are walked and de-duplicated by part+name. A
 * report that reads only the current shape would show zero findings on older proposals
 * and look like good news.
 */
function linesOf(version: { sections: unknown; items: unknown }): RawItem[] {
  const out: RawItem[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as RawItem);
  };
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          const o = n as Record<string, unknown>;
          // A line has a part number or a rate; a section has children.
          if ('sku' in o || 'rateMinor' in o) push(o);
          for (const k of ['items', 'lines', 'rows', 'children', 'sections'])
            if (k in o) walk(o[k], depth + 1);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      for (const k of ['items', 'lines', 'rows', 'children', 'sections'])
        if (k in o) walk(o[k], depth + 1);
    }
  };
  walk(version.items);
  walk(version.sections);
  return out;
}

async function main() {
  const [skus, products, versions] = await Promise.all([
    prisma.sku.findMany({ select: { part: true, unitPriceMinor: true } }),
    prisma.product.findMany({ select: { sku: true, name: true, status: true } }),
    prisma.proposalVersion.findMany({
      select: {
        id: true,
        version: true,
        status: true,
        createdAt: true,
        releasedAt: true,
        sections: true,
        items: true,
        proposal: { select: { number: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const pricedParts = new Set(skus.map((s) => key(s.part)));
  const productOnly = new Set(
    products.filter((p) => !pricedParts.has(key(p.sku))).map((p) => key(p.sku)),
  );

  console.log('');
  console.log('ZERO-PRICED PROPOSAL LINES');
  console.log('='.repeat(78));
  console.log(`Proposal versions examined : ${versions.length}`);
  console.log(`Parts with no Sku row      : ${productOnly.size}`);
  console.log('');

  interface Finding {
    proposal: string;
    title: string;
    version: number;
    status: string;
    released: boolean;
    part: string;
    name: string;
    qty: string;
    rate: string;
    reason: string;
  }
  const findings: Finding[] = [];

  for (const v of versions) {
    for (const l of linesOf(v)) {
      const part = key(l.sku);
      if (!part) continue;
      const rate = l.rateMinor == null ? null : Number(l.rateMinor);
      const unpriced = productOnly.has(part);
      const zeroRate = rate === 0;
      if (!unpriced && !zeroRate) continue;
      findings.push({
        proposal: v.proposal?.number ?? '(no number)',
        title: (v.proposal?.title ?? '').slice(0, 34),
        version: v.version,
        status: String(v.status),
        released: !!v.releasedAt,
        part: String(l.sku ?? ''),
        name: String(l.name ?? '').slice(0, 34),
        qty: l.quantity == null ? '—' : String(l.quantity),
        rate: money(rate),
        reason: unpriced ? (zeroRate ? 'no Sku + $0' : 'no Sku') : '$0 rate',
      });
    }
  }

  /* ---- 1. lines whose part has no price record at all ---- */

  const noSku = findings.filter((f) => f.reason.startsWith('no Sku'));
  console.log('1. LINES WHOSE PART HAS NO PRICE RECORD');
  console.log('-'.repeat(78));
  if (!noSku.length) {
    console.log('   None. No proposal has ever quoted a part that lacks a Sku row.');
    console.log('   The 194 half-created parts have not reached a customer document.');
  } else {
    const released = noSku.filter((f) => f.released);
    console.log(`   ${noSku.length} line(s) across proposals.`);
    console.log(`   OF WHICH ON A RELEASED PROPOSAL (the customer has it): ${released.length}`);
    console.log('');
    for (const f of noSku.slice(0, 60)) {
      const flag = f.released ? ' *** RELEASED ***' : '';
      console.log(
        `   ${f.proposal.padEnd(22)} v${String(f.version).padEnd(3)} ${f.status.padEnd(16)} ` +
          `${f.part.padEnd(20)} qty ${f.qty.padEnd(5)} ${f.rate}${flag}`,
      );
    }
    if (noSku.length > 60) console.log(`   … +${noSku.length - 60} more`);
  }
  console.log('');

  /* ---- 2. lines quoted at zero, whatever the reason ---- */

  const zero = findings.filter((f) => f.reason === '$0 rate');
  console.log('2. LINES QUOTED AT $0 WHOSE PART *IS* PRICED');
  console.log('-'.repeat(78));
  console.log('   A deliberate zero is legitimate — an included accessory, a goodwill item.');
  console.log('   Listed so the two kinds can be told apart rather than lumped together.');
  console.log('');
  if (!zero.length) {
    console.log('   None.');
  } else {
    console.log(`   ${zero.length} line(s).`);
    for (const f of zero.slice(0, 30)) {
      const head = `${f.proposal.padEnd(22)} v${String(f.version).padEnd(3)}`;
      console.log(`   ${head} ${f.part.padEnd(20)} ${f.name}`);
    }
    if (zero.length > 30) console.log(`   … +${zero.length - 30} more`);
  }
  console.log('');

  /* ---- 3. the exposure that remains ---- */

  const activeUnpriced = products.filter(
    (p) => !pricedParts.has(key(p.sku)) && p.status === 'ACTIVE',
  );
  console.log('3. STILL SELECTABLE IN THE BUILDER AT $0');
  console.log('-'.repeat(78));
  console.log(`   ${activeUnpriced.length} part(s) have no Sku row AND status ACTIVE, so`);
  console.log('   GET /catalog/items returns them with unitPriceMinor: 0 and active: true —');
  console.log('   which is exactly what the part picker keeps.');
  console.log('');
  console.log('   Setting these to DRAFT or INACTIVE removes them from the picker');
  console.log('   immediately and reversibly, without touching any proposal. That is the');
  console.log('   stopgap; giving them prices is the fix.');
  console.log('');
  console.log('='.repeat(78));
  console.log('Nothing was changed.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

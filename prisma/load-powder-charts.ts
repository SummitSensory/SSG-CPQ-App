/**
 * Load the customer portal's Cardinal and Prismatic powder-coat charts into the CRM.
 *
 * WHY
 * ---
 * The customer portal sends a frame colour as brand + code only — `{ "brand":
 * "cardinal", "code": "T013-BL468" }`. The colour's NAME lives in the portal's own chart
 * files, not in the answer. `lineColorFor` in src/portal/colorAreas.ts prints the name
 * between brand and code ("Cardinal Blue Hammer T013-BL468") when it finds the code on a
 * POWDER_COAT palette whose name (or owner's name) is the brand. With no such palette the
 * Bill of Materials and Purchase Order print only "Cardinal T013-BL468": the vendor code
 * is right, but the shop reads names.
 *
 * WHERE THE CHARTS LIVE
 * ---------------------
 * As two VendorColorPalette rows named exactly "Cardinal" and "Prismatic" (finish
 * POWDER_COAT) under the manufacturer "Goldberg Brothers". Goldberg applies the powder;
 * Cardinal and Prismatic are paint brands, not vendors anyone orders from, so they get
 * no Manufacturer row of their own (one would appear in every vendor picker).
 *
 * SOURCE
 * ------
 * prisma/data/powder-charts/{cardinal,prismatic}.json, copied from the Customer-Portal
 * repo (lib/data/cardinalColors.json and prismaticColors.json) at commit
 * f203ace99cac285143001d6a8a776904da434c45 — the lists customers actually pick from.
 * Reduced to { name, code } (Prismatic's `sku` is its code), trimmed, source order kept.
 *
 * Cardinal's chart repeats some names with different codes ("Blue 90 Gloss" is both
 * T009-BL01 and T009-BL05). A palette's colour names are unique, so every name in such
 * a group carries its code in parentheses — "Blue 90 Gloss (T009-BL05)". 13 groups, 30
 * colours; Prismatic has none. No code is repeated in either chart. `lineColorFor` drops
 * that bracketed code when it prints, since the code follows the name anyway:
 * "Cardinal Blue 90 Gloss T009-BL05", not "… (T009-BL05) T009-BL05".
 *
 * WHAT IT DOES
 * ------------
 *   - Fails if "Goldberg Brothers" does not exist.
 *   - Creates or updates each palette (POWDER_COAT, active).
 *   - Creates or updates each colour by (palette, name): vendor code and sort order.
 *   - Never deletes. A colour already on a palette but absent from the file is reported
 *     and left alone — it may be on a historic sheet, and retiring it is a person's call.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx prisma/load-powder-charts.ts
 *   npx tsx prisma/load-powder-charts.ts --apply
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const OWNER = 'Goldberg Brothers';
const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data', 'powder-charts');

const CHARTS = [
  { palette: 'Cardinal', file: 'cardinal.json' },
  { palette: 'Prismatic', file: 'prismatic.json' },
] as const;

interface ChartColor {
  name: string;
  code: string;
}

function readChart(file: string): ChartColor[] {
  const raw = JSON.parse(readFileSync(join(DATA, file), 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file} is not a list`);
  const rows = raw.map((r: { name?: unknown; code?: unknown }) => ({
    name: String(r?.name ?? '').trim(),
    code: String(r?.code ?? '').trim(),
  }));
  const bad = rows.filter((r) => !r.name || !r.code);
  if (bad.length) throw new Error(`${file}: ${bad.length} colour(s) without a name or code`);
  const names = new Set<string>();
  for (const r of rows) {
    if (names.has(r.name)) throw new Error(`${file}: "${r.name}" appears twice`);
    names.add(r.name);
  }
  return rows;
}

async function main() {
  console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written (pass --apply)');
  const owner = await prisma.manufacturer.findUnique({
    where: { name: OWNER },
    select: { id: true },
  });
  if (!owner) throw new Error(`Manufacturer "${OWNER}" not found — nothing loaded.`);

  for (const chart of CHARTS) {
    const colors = readChart(chart.file);
    const existing = await prisma.vendorColorPalette.findUnique({
      where: { manufacturerId_name: { manufacturerId: owner.id, name: chart.palette } },
      include: { colors: true },
    });

    let paletteId = existing?.id ?? null;
    const paletteNeedsUpdate =
      !!existing && (existing.finishType !== 'POWDER_COAT' || !existing.active);
    console.log(
      `\n== ${chart.palette} (${colors.length} colours in file): palette ${
        !existing ? 'will be CREATED' : paletteNeedsUpdate ? 'will be UPDATED' : 'exists'
      }`,
    );
    if (APPLY) {
      if (!existing) {
        paletteId = (
          await prisma.vendorColorPalette.create({
            data: {
              manufacturerId: owner.id,
              name: chart.palette,
              finishType: 'POWDER_COAT',
              active: true,
              notes: `Loaded from the customer portal chart (${chart.file}).`,
            },
          })
        ).id;
      } else if (paletteNeedsUpdate) {
        await prisma.vendorColorPalette.update({
          where: { id: existing.id },
          data: { finishType: 'POWDER_COAT', active: true },
        });
      }
    }

    const byName = new Map((existing?.colors ?? []).map((c) => [c.name, c]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const [i, c] of colors.entries()) {
      const have = byName.get(c.name);
      if (!have) {
        created++;
        if (APPLY && paletteId) {
          await prisma.vendorColor.create({
            data: { paletteId, name: c.name, vendorCode: c.code, sortOrder: i },
          });
        }
      } else if (have.vendorCode !== c.code || have.sortOrder !== i) {
        updated++;
        console.log(
          `   update ${c.name}: code ${have.vendorCode} → ${c.code}, order ${have.sortOrder} → ${i}`,
        );
        if (APPLY) {
          await prisma.vendorColor.update({
            where: { id: have.id },
            data: { vendorCode: c.code, sortOrder: i },
          });
        }
      } else {
        unchanged++;
      }
    }
    const inFile = new Set(colors.map((c) => c.name));
    const extra = (existing?.colors ?? []).filter((c) => !inFile.has(c.name));
    console.log(`   colours: ${created} created, ${updated} updated, ${unchanged} unchanged`);
    for (const c of extra) {
      console.log(
        `   on the palette but not in the file (left alone): ${c.name} ${c.vendorCode ?? ''}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

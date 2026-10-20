import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { can } from '../authz/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { recordRevision, skuSnapshot } from '../lib/revisions.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { loadVendorIndex, resolveVendor } from '../catalog/partVendor.js';
import { DEFAULT_HARDWARE_RULES } from '../proposals/hardwareRules.js';
import { FORCED_HARDWARE } from '../handoff/bomRollup.js';
import { HARDWARE, isHardwareHeading, normalizeHeading } from '../handoff/bomLayout.js';
import { processingFeeOf } from '../catalog/landedCost.js';
import {
  BOM_COLUMNS,
  BOM_COLUMN_LABELS_KEY,
  BOM_LABEL_MAX,
  loadBomColumnLabels,
  saveBomColumnLabels,
} from '../handoff/bomColumnLabels.js';

/**
 * Catalog → BOM setup, and the two order-page actions that write back to it.
 *
 * Everything the manufacturing team needs to make a Bill of Materials read the way
 * they want, for every future order, without a code change and without editing parts
 * one card at a time:
 *
 *   * Sequence  (Sku.bomSortOrder) — where the part sits on its vendor's sheet.
 *   * Heading   (Sku.bomGroup)     — Hardware, the main list, or a heading they name.
 *   * BOM note  (Sku.bomNote)      — a standing instruction copied onto every order.
 *   * Processing — the checkbox beside the part number. A part bought from its
 *     Procurement Supplier (Amazon) and sent to a Processing Service Supplier
 *     (Goldberg) prints on BOTH sheets: the purchase stays on the procurement
 *     supplier's, and a line is added on the processing supplier's at their
 *     Repackaging Service Fee (per unit or per order) under their Repackaging SKU.
 *     See bomBuild.ts. The fee is also added to the part's cost on new proposals
 *     (src/catalog/landedCost.ts), so cost of goods and margin include it.
 *
 * None of it changes a price, an existing proposal or an accepted order's totals —
 * the Repackaging Service Fee reaches only proposal lines added from now on, as the
 * part's cost — so it is open to whoever runs the BOM (HANDOFF_MANAGE),
 * not only catalog admins. The one exception is saving a line's COST back to the
 * catalog, which moves every future proposal's margin and so still needs
 * PRODUCTS_ADMIN.
 */

const PART = z.string().trim().min(1).max(80);
const HEADING = z.union([z.string().trim().max(60), z.null()]);
const VENDOR = z.union([z.string().trim().max(160), z.null()]);

const FEE_BASIS = z.enum(['PER_UNIT', 'PER_ORDER']);
const REPACKAGING_SKU = z.union([z.string().trim().max(80), z.null()]);

const BulkSet = z
  .object({
    /** The checkbox: this part goes through a Processing Service Supplier. */
    processingEnabled: z.boolean().optional(),
    /** The Processing Service Supplier. */
    secondaryVendor: VENDOR.optional(),
    /** The Repackaging Service Fee. */
    secondaryVendorCostMinor: z.union([z.number().int().min(0), z.null()]).optional(),
    processingFeeBasis: FEE_BASIS.optional(),
    /** The Repackaging SKU. */
    processingSku: REPACKAGING_SKU.optional(),
    /**
     * Clearing only: dismisses a retired "ships through" vendor the migration could not
     * convert. Nothing can set one any more.
     */
    freeIssueVendor: z.null().optional(),
    bomGroup: HEADING.optional(),
    bomNote: z.union([z.string().trim().max(500), z.null()]).optional(),
    bomSortOrder: z.union([z.number().int().min(0).max(1_000_000), z.null()]).optional(),
  })
  .strict();

const BulkBody = z.object({
  parts: z.array(PART).min(1).max(2000),
  set: BulkSet,
});

const SequenceBody = z.object({
  /** Parts in the order they should print. Numbered 10, 20, 30… */
  parts: z.array(PART).min(1).max(2000),
  start: z.number().int().min(0).max(1_000_000).default(10),
  step: z.number().int().min(1).max(10_000).default(10),
});

const ArrangeBody = z.object({
  vendor: z.string().trim().min(1).max(160),
  /** Every line on the vendor's sheet, in the order it should print. */
  lineIds: z.array(z.string().min(1).max(40)).min(1).max(2000),
  /** Per-line heading for this order. Absent = leave as it is; null = automatic. */
  headings: z.record(HEADING).optional(),
  /** Also make this the part's preset for every future order. */
  saveForFuture: z.boolean().default(false),
});

const SaveDefaultBody = z.object({
  fields: z.array(z.enum(['vendorNotes', 'unitCost', 'bomGroup'])).min(1),
});

/**
 * The spreadsheet round trip. Column names are the ones the export writes, so a
 * downloaded sheet uploads back untouched. Only columns present in the file are
 * written; a column present but blank CLEARS the field — the same rule the catalog
 * importer follows. Heading: blank = automatic, "Main list" = always the main list.
 */
export const SHEET_COLUMNS = [
  'part',
  'description',
  // Read-only on upload: who we buy it from is catalog data, set in the catalog.
  'procurementSupplier',
  'unitPurchaseCost',
  'bomSequence',
  'bomHeading',
  'bomNote',
  'processing',
  'processingSupplier',
  'repackagingSku',
  'repackagingFee',
  'repackagingFeeBasis',
] as const;
const MAIN_LIST = 'Main list';
const PER_ORDER_TEXT = 'per order';
const PER_UNIT_TEXT = 'per unit';

/**
 * Sheets downloaded before the processing-supplier columns still upload: the old
 * "also on vendor" columns are the same fields under their old names, and an old
 * "ships through" vendor becomes the processing supplier, which keeps the part on its
 * purchase vendor's sheet as well.
 */
const LEGACY_COLUMNS: Record<string, string> = {
  alsoOnVendor: 'processingSupplier',
  alsoOnVendorCost: 'repackagingFee',
  shipsThroughVendor: 'processingSupplier',
};

const ImportBody = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
  dryRun: z.boolean().default(true),
});

const UNASSIGNED = 'Unassigned vendor';
const vendorOf = (v: string | null | undefined): string => (v && v.trim()) || UNASSIGNED;
const upper = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase();

/**
 * Each part's Procurement Supplier and Unit Purchase Cost, resolved the way the Bill of
 * Materials resolves them when an order is locked (service.ts resolveCatalogRefs,
 * bomBuild.ts partInfo): Sku.manufacturer is the ordering override, then the
 * product's primary sourcing; Sku.unitCostMinor, then the latest ProductCost. Showing
 * Sku.manufacturer alone printed "—" for a part whose vendor is on its sourcing, which
 * is not what its BOM line says.
 */
async function procurementFor(
  skus: Array<{ part: string; manufacturer: string | null; unitCostMinor: number }>,
): Promise<Map<string, { supplier: string | null; unitCostMinor: number }>> {
  const products = await prisma.product.findMany({
    where: { sku: { in: skus.map((s) => s.part), mode: 'insensitive' } },
    select: {
      id: true,
      sku: true,
      sourcing: {
        select: { manufacturer: { select: { name: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
      },
    },
  });
  // Only parts whose Sku carries no cost need the dated history.
  const skuCost = new Map(skus.map((s) => [upper(s.part), s.unitCostMinor]));
  const needCost = products.filter((p) => !skuCost.get(upper(p.sku))).map((p) => p.id);
  const latestCost = new Map<string, number>();
  if (needCost.length)
    for (const c of await prisma.productCost.findMany({
      where: { productId: { in: needCost } },
      select: { productId: true, unitCost: true },
      orderBy: { effectiveDate: 'desc' },
    }))
      if (!latestCost.has(c.productId)) latestCost.set(c.productId, Number(c.unitCost));
  const byPart = new Map(products.map((p) => [upper(p.sku), p]));
  return new Map(
    skus.map((s) => {
      const p = byPart.get(upper(s.part));
      return [
        upper(s.part),
        {
          supplier: (s.manufacturer || '').trim() || p?.sourcing[0]?.manufacturer?.name || null,
          unitCostMinor: s.unitCostMinor || (p ? (latestCost.get(p.id) ?? 0) : 0),
        },
      ];
    }),
  );
}

/** Every Sku row matching these part numbers, case-insensitively, keyed upper-case. */
async function skusFor(parts: string[]) {
  const rows = await prisma.sku.findMany({
    where: { part: { in: [...new Set(parts.map((p) => p.trim()))], mode: 'insensitive' } },
  });
  return new Map(rows.map((r) => [upper(r.part), r]));
}

/** Write one SKU and keep its history, the same record the catalog editor keeps. */
async function updateSku(
  before: Awaited<ReturnType<typeof prisma.sku.findUniqueOrThrow>>,
  data: Record<string, unknown>,
  actorId: string,
  note: string,
) {
  const after = await prisma.sku.update({ where: { id: before.id }, data });
  await recordRevision({
    entity: 'Sku',
    entityId: after.id,
    label: after.part,
    action: 'update',
    actorId,
    before: skuSnapshot(before as unknown as Record<string, unknown>),
    after: skuSnapshot(after as unknown as Record<string, unknown>),
    note,
  });
  return after;
}

export function registerBomSetupRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const handoff = { preHandler: requirePermission(Permission.HANDOFF_MANAGE) };

  /**
   * Every part with its BOM settings, in one read. The catalog is a few hundred rows,
   * so the screen filters in the browser — that is what makes selecting fifty parts
   * and changing them together instant rather than a page-by-page hunt.
   */
  app.get('/bom-setup/parts', read, async () => {
    const [skus, rules] = await Promise.all([
      prisma.sku.findMany({
        orderBy: [{ part: 'asc' }],
        select: {
          part: true,
          description: true,
          category: true,
          manufacturer: true,
          unitCostMinor: true,
          active: true,
          freeIssueVendor: true,
          processingEnabled: true,
          secondaryVendor: true,
          secondaryVendorCostMinor: true,
          processingFeeBasis: true,
          processingSku: true,
          bomSortOrder: true,
          bomGroup: true,
          bomNote: true,
        },
      }),
      prisma.hardwareRule.findMany({ where: { kind: 'HARDWARE' }, select: { part: true } }),
    ]);
    const kitParts = new Set(DEFAULT_HARDWARE_RULES.map((r) => upper(r.part)));
    const ruleParts = new Set(rules.map((r) => upper(r.part)));
    const procurement = await procurementFor(skus);
    return {
      parts: skus.map((s) => {
        const k = upper(s.part);
        // What "Automatic" resolves to for this part, so the screen can show it.
        const autoHardware = kitParts.has(k) || ruleParts.has(k) || FORCED_HARDWARE.has(k);
        const proc = procurement.get(k);
        const fee = processingFeeOf(s);
        const { freeIssueVendor, ...rest } = s;
        return {
          ...rest,
          autoHeading: autoHardware ? HARDWARE : '',
          procurementSupplier: proc?.supplier ?? null,
          unitPurchaseCostMinor: proc?.unitCostMinor ?? s.unitCostMinor,
          // What a NEW proposal line will carry as this part's cost (landedCost.ts).
          proposalUnitCostMinor: (proc?.unitCostMinor ?? s.unitCostMinor) + fee.perUnitMinor,
          proposalPerOrderFeeMinor: fee.perOrderMinor,
          // A retired "ships through" vendor migration 0120 could not convert, because
          // the part already named a different processing supplier. Nothing routes on
          // it; it is shown so somebody decides, then cleared.
          legacyShipsThrough: (freeIssueVendor || '').trim() || null,
        };
      }),
    };
  });

  /**
   * One change applied to many parts. Only the fields sent are written; null clears.
   * Vendor names must already be on record — a typo here would route parts to a
   * vendor sheet nobody is ever sent.
   */
  app.patch('/bom-setup/parts', handoff, async (req) => {
    const parsed = BulkBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid change');
    const { parts, set } = parsed.data;
    if (!Object.keys(set).length) throw new ValidationError('Nothing to change.');

    const data: Record<string, unknown> = {};
    if (set.secondaryVendor !== undefined) {
      const typed = set.secondaryVendor;
      if (!typed) data.secondaryVendor = null;
      else {
        const v = resolveVendor(await loadVendorIndex(prisma), typed);
        if (!v)
          throw new ValidationError(
            `“${typed}” is not a manufacturer on record. Add it under Catalog → Manufacturers first.`,
          );
        data.secondaryVendor = v.name;
      }
    }
    if (set.processingEnabled !== undefined) data.processingEnabled = set.processingEnabled;
    if (set.secondaryVendorCostMinor !== undefined)
      data.secondaryVendorCostMinor = set.secondaryVendorCostMinor;
    if (set.processingFeeBasis !== undefined) data.processingFeeBasis = set.processingFeeBasis;
    if (set.processingSku !== undefined)
      data.processingSku = (set.processingSku ?? '').trim() || null;
    if (set.freeIssueVendor !== undefined) data.freeIssueVendor = null;
    if (set.bomGroup !== undefined) data.bomGroup = normalizeHeading(set.bomGroup);
    if (set.bomNote !== undefined) data.bomNote = (set.bomNote ?? '').trim() || null;
    if (set.bomSortOrder !== undefined) data.bomSortOrder = set.bomSortOrder;

    const found = await skusFor(parts);
    const missing = [...new Set(parts.map(upper))].filter((p) => !found.has(p));
    const skipped: Array<{ part: string; reason: string }> = missing.map((p) => ({
      part: p,
      reason: 'Not in the SKU master',
    }));
    const procurement = await procurementFor([...found.values()]);
    let updated = 0;
    for (const sku of found.values()) {
      // A part processed by the supplier it is bought from would print twice on that
      // one sheet — the purchase and the fee for the same units.
      const own = (procurement.get(upper(sku.part))?.supplier ?? '').toLowerCase();
      const target = String(data.secondaryVendor ?? '').toLowerCase();
      if (target && own && target === own) {
        skipped.push({
          part: sku.part,
          reason: `Already bought from ${procurement.get(upper(sku.part))?.supplier}`,
        });
        continue;
      }
      await updateSku(sku, data, req.user!.sub, 'BOM setup (bulk)');
      updated++;
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bom.setup.bulk',
      entity: 'Sku',
      details: { parts: [...found.keys()], set: data, skipped },
    });
    return { updated, skipped };
  });

  /** The Bill of Materials column headings: each one's default, where it shows, and what it reads now. */
  app.get('/bom-setup/column-labels', read, async () => {
    const labels = await loadBomColumnLabels();
    return {
      columns: BOM_COLUMNS.map((c) => ({
        ...c,
        default: c.label,
        label: labels[c.key] ?? c.label,
      })),
    };
  });

  /**
   * Rename headings. A blank or default heading goes back to following its default.
   * Every order's BOM — screen, PDF, Excel, CSV and the emailed copy — reads them on
   * its next load; nothing is stored on the orders themselves.
   */
  app.put('/bom-setup/column-labels', handoff, async (req) => {
    const parsed = z
      .object({ labels: z.record(z.string(), z.string().max(BOM_LABEL_MAX).nullable()) })
      .safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid headings');
    const labels = await saveBomColumnLabels(parsed.data.labels, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bom.setup.columnLabels',
      entity: 'UiSetting',
      entityId: BOM_COLUMN_LABELS_KEY,
      details: { labels },
    });
    return {
      columns: BOM_COLUMNS.map((c) => ({
        ...c,
        default: c.label,
        label: labels[c.key] ?? c.label,
      })),
    };
  });

  /** The BOM setup sheet, in the columns the importer reads back. */
  app.get('/bom-setup/export', read, async () => {
    const skus = await prisma.sku.findMany({
      orderBy: [{ manufacturer: 'asc' }, { bomSortOrder: 'asc' }, { part: 'asc' }],
    });
    const procurement = await procurementFor(skus);
    return {
      columns: SHEET_COLUMNS,
      items: skus.map((s) => {
        const proc = procurement.get(upper(s.part));
        return {
          part: s.part,
          description: s.description,
          procurementSupplier: proc?.supplier ?? '',
          unitPurchaseCost: ((proc?.unitCostMinor ?? s.unitCostMinor) / 100).toFixed(2),
          bomSequence: s.bomSortOrder ?? '',
          bomHeading: s.bomGroup === null ? '' : s.bomGroup === '' ? MAIN_LIST : s.bomGroup,
          bomNote: s.bomNote ?? '',
          processing: s.processingEnabled ? 'Yes' : 'No',
          processingSupplier: s.secondaryVendor ?? '',
          repackagingSku: s.processingSku ?? '',
          repackagingFee:
            s.secondaryVendorCostMinor == null ? '' : (s.secondaryVendorCostMinor / 100).toFixed(2),
          repackagingFeeBasis:
            s.processingFeeBasis === 'PER_ORDER' ? PER_ORDER_TEXT : PER_UNIT_TEXT,
        };
      }),
    };
  });

  /**
   * Upload the sheet back. A dry run (the default) reports what would change, row by
   * row, and writes nothing; the screen shows that before the second, real call.
   */
  app.post('/bom-setup/import', handoff, async (req) => {
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('The file has no rows.');
    const { rows, dryRun } = parsed.data;
    const index = await loadVendorIndex(prisma);
    const found = await skusFor(rows.map((r) => String(r.part ?? '')).filter(Boolean));
    const procurement = await procurementFor([...found.values()]);
    const has = (r: Record<string, unknown>, k: string) =>
      Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
    const str = (v: unknown) => String(v ?? '').trim();

    const issues: Array<{ row: number; part: string; message: string }> = [];
    const changes: Array<{ row: number; part: string; changed: string[] }> = [];
    const writes: Array<{
      sku: NonNullable<ReturnType<typeof found.get>>;
      data: Record<string, unknown>;
    }> = [];

    rows.forEach((raw, i) => {
      const row = i + 2; // header is row 1 in the spreadsheet
      // An older sheet's column names, read as the new ones they became. A new column
      // in the same file wins; a blank legacy "ships through" never clears anything.
      const r: Record<string, unknown> = { ...raw };
      for (const [old, now] of Object.entries(LEGACY_COLUMNS)) {
        if (!has(raw, old) || has(r, now)) continue;
        if (old === 'shipsThroughVendor' && !String(raw[old] ?? '').trim()) continue;
        // An old export wrote every column on every row: a free-issue part reads
        // alsoOnVendor "" beside its ship-through vendor. That blank is not a choice to
        // clear the supplier; the ship-through vendor below is the one to take.
        if (
          old === 'alsoOnVendor' &&
          !String(raw[old] ?? '').trim() &&
          String(raw.shipsThroughVendor ?? '').trim()
        )
          continue;
        r[now] = raw[old];
        if (
          now === 'processingSupplier' &&
          !has(raw, 'processing') &&
          String(raw[old] ?? '').trim()
        )
          r.processing = 'Yes';
      }
      const part = str(r.part);
      if (!part) return;
      const sku = found.get(upper(part));
      if (!sku) {
        issues.push({ row, part, message: 'Not in the SKU master' });
        return;
      }
      const data: Record<string, unknown> = {};
      const bad = (message: string) => issues.push({ row, part, message });

      if (has(r, 'bomSequence')) {
        const v = str(r.bomSequence);
        const n = Number(v);
        if (v && (!Number.isInteger(n) || n < 0)) bad('bomSequence must be a whole number');
        else data.bomSortOrder = v ? n : null;
      }
      if (has(r, 'bomHeading')) {
        const v = str(r.bomHeading);
        data.bomGroup = !v
          ? null
          : v.toLowerCase() === MAIN_LIST.toLowerCase()
            ? ''
            : v.slice(0, 60);
      }
      if (has(r, 'bomNote')) data.bomNote = str(r.bomNote).slice(0, 500) || null;
      if (has(r, 'processing')) {
        const v = str(r.processing).toLowerCase();
        if (['yes', 'y', 'true', '1', 'x'].includes(v)) data.processingEnabled = true;
        else if (['', 'no', 'n', 'false', '0'].includes(v)) data.processingEnabled = false;
        else bad('processing must be Yes or No');
      }
      if (has(r, 'processingSupplier')) {
        const v = str(r.processingSupplier);
        const own = (procurement.get(upper(sku.part))?.supplier ?? '').toLowerCase();
        const vendor = v ? resolveVendor(index, v) : null;
        if (!v) data.secondaryVendor = null;
        else if (!vendor) bad(`processingSupplier “${v}” is not a manufacturer on record`);
        else if (own && vendor.name.toLowerCase() === own)
          bad('processingSupplier is the procurement supplier it is already bought from');
        else data.secondaryVendor = vendor.name;
      }
      if (has(r, 'repackagingSku')) data.processingSku = str(r.repackagingSku).slice(0, 80) || null;
      if (has(r, 'repackagingFee')) {
        const v = str(r.repackagingFee).replace(/[$,\s]/g, '');
        const n = Number(v);
        if (v && (!Number.isFinite(n) || n < 0)) bad('repackagingFee must be a dollar amount');
        else data.secondaryVendorCostMinor = v ? Math.round(n * 100) : null;
      }
      if (has(r, 'repackagingFeeBasis')) {
        const v = str(r.repackagingFeeBasis)
          .toLowerCase()
          .replace(/[\s_-]+/g, ' ');
        if (!v || v === PER_UNIT_TEXT || v === 'unit') data.processingFeeBasis = 'PER_UNIT';
        else if (v === PER_ORDER_TEXT || v === 'order') data.processingFeeBasis = 'PER_ORDER';
        else bad('repackagingFeeBasis must be "per unit" or "per order"');
      }
      // Ticked with no supplier routes nothing — said now, not found on an order.
      const willProcess = data.processingEnabled ?? sku.processingEnabled;
      const willSupplier =
        data.secondaryVendor !== undefined ? data.secondaryVendor : sku.secondaryVendor;
      if (willProcess && !willSupplier && data.processingEnabled) {
        bad('processing is Yes but no processingSupplier is given');
        delete data.processingEnabled;
      }

      // Only what actually differs, so the preview lists real changes, not every row.
      const current = sku as unknown as Record<string, unknown>;
      const changed = Object.keys(data).filter((k) => (current[k] ?? null) !== (data[k] ?? null));
      if (!changed.length) return;
      changes.push({ row, part: sku.part, changed });
      writes.push({ sku, data: Object.fromEntries(changed.map((k) => [k, data[k]])) });
    });

    if (dryRun) return { dryRun: true, changes, issues };
    for (const w of writes) await updateSku(w.sku, w.data, req.user!.sub, 'BOM setup (import)');
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bom.setup.import',
      entity: 'Sku',
      details: { updated: writes.length, issues: issues.length },
    });
    return { dryRun: false, updated: writes.length, changes, issues };
  });

  /** Number parts in the order given: 10, 20, 30… so one can be slotted in later. */
  app.post('/bom-setup/sequence', handoff, async (req) => {
    const parsed = SequenceBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid sequence');
    const { parts, start, step } = parsed.data;
    const found = await skusFor(parts);
    let n = start;
    let updated = 0;
    const seen = new Set<string>();
    for (const p of parts) {
      const k = upper(p);
      if (seen.has(k)) continue;
      seen.add(k);
      const sku = found.get(k);
      if (!sku) continue;
      if (sku.bomSortOrder !== n) {
        await updateSku(sku, { bomSortOrder: n }, req.user!.sub, 'BOM setup (sequence)');
        updated++;
      }
      n += step;
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: 'bom.setup.sequence',
      entity: 'Sku',
      details: { parts: [...seen], start, step },
    });
    return { updated };
  });

  /**
   * Hardware check: every part that prints under Hardware, and WHY.
   *
   * A part lands under Hardware for one of five reasons, set in four different places
   * (the H-1000 kit's formula list, a hardware rule, a code list, the part's own
   * heading). Without this, the only way to find out why a gate handle is filed with
   * the bolts was to read the code. Here each part says which reason applies, how many
   * open orders carry it, and can be moved out with one click on the screen.
   */
  app.get('/bom-setup/hardware-check', read, async () => {
    const [rules, flagged, kitLines] = await Promise.all([
      prisma.hardwareRule.findMany({
        where: { kind: 'HARDWARE' },
        select: { part: true, name: true, active: true },
      }),
      prisma.sku.findMany({ where: { NOT: { bomGroup: null } }, select: { part: true } }),
      prisma.procurementLine.findMany({
        where: { isHardwareComponent: true, sku: { not: null } },
        select: { sku: true, kitSku: true, orderId: true, bomGroup: true },
      }),
    ]);
    const reasons = new Map<string, Set<string>>();
    const add = (part: string, why: string) => {
      const k = upper(part);
      if (!k) return;
      const s = reasons.get(k) ?? new Set<string>();
      s.add(why);
      reasons.set(k, s);
    };
    for (const r of DEFAULT_HARDWARE_RULES) add(r.part, 'In the H-1000 hardware kit formula');
    for (const r of rules) add(r.part, 'Has a hardware rule under Settings → Formulas');
    for (const p of FORCED_HARDWARE) add(p, 'Always filed under Hardware (eye-bolt roll-up)');
    for (const l of kitLines) add(l.sku ?? '', `Came out of ${l.kitSku || 'a kit'} on an order`);

    const ordersByPart = new Map<string, Set<string>>();
    for (const l of kitLines) {
      const k = upper(l.sku);
      const s = ordersByPart.get(k) ?? new Set<string>();
      s.add(l.orderId);
      ordersByPart.set(k, s);
    }

    const candidates = [...new Set([...reasons.keys(), ...flagged.map((f) => upper(f.part))])];
    const skus = await skusFor(candidates);
    const rows = candidates
      .map((k) => {
        const s = skus.get(k);
        const catalogHeading = s?.bomGroup ?? null;
        const auto = reasons.has(k) ? HARDWARE : '';
        const effective = catalogHeading ?? auto;
        return {
          part: s?.part ?? k,
          description: s?.description ?? '',
          category: s?.category ?? '',
          manufacturer: s?.manufacturer ?? '',
          inCatalog: !!s,
          reasons: [...(reasons.get(k) ?? [])],
          catalogHeading,
          effectiveHeading: effective,
          printsUnderHardware: isHardwareHeading(effective),
          orders: ordersByPart.get(k)?.size ?? 0,
        };
      })
      // Only what is, or would be by default, under Hardware — a part the team has
      // already moved out stays listed so the move can be seen and undone.
      .filter((r) => r.printsUnderHardware || r.reasons.length)
      .sort(
        (a, b) =>
          Number(b.printsUnderHardware) - Number(a.printsUnderHardware) ||
          a.part.localeCompare(b.part),
      );
    return { rows };
  });

  /**
   * Rearrange one vendor's sheet on one order, and optionally keep that arrangement
   * for every future order.
   *
   * The order's own lines get a position (10, 20, 30…) and any heading chosen, which
   * wins over the catalog for this order. With saveForFuture, each part's position
   * and heading are ALSO written to the catalog, so the next order locked prints
   * the same way without anyone arranging it again.
   */
  app.post('/orders/:id/bom/arrange', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ArrangeBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid arrangement');
    const { vendor, lineIds, headings, saveForFuture } = parsed.data;

    const section = await prisma.bomVendorSection.findUnique({
      where: { orderId_vendor: { orderId: id, vendor } },
      select: { status: true },
    });
    if (section?.status === 'SUBMITTED')
      throw new ValidationError(
        `The ${vendor} Bill of Materials is submitted. Unlock it before rearranging it.`,
      );

    const lines = await prisma.procurementLine.findMany({
      where: { orderId: id, id: { in: lineIds } },
      select: { id: true, sku: true, vendor: true, bomGroup: true },
    });
    const byId = new Map(lines.map((l) => [l.id, l]));
    const foreign = lineIds.filter((l) => !byId.has(l) || vendorOf(byId.get(l)?.vendor) !== vendor);
    if (foreign.length)
      throw new ValidationError(
        `Some of those lines are not on the ${vendor} sheet of this order.`,
      );

    const headingFor = (lineId: string): string | null | undefined =>
      headings && Object.prototype.hasOwnProperty.call(headings, lineId)
        ? normalizeHeading(headings[lineId])
        : undefined;

    await prisma.$transaction(
      lineIds.map((lineId, i) => {
        const h = headingFor(lineId);
        return prisma.procurementLine.update({
          where: { id: lineId },
          data: { bomPosition: (i + 1) * 10, ...(h !== undefined ? { bomGroup: h } : {}) },
        });
      }),
    );

    let catalogUpdated = 0;
    const notInCatalog: string[] = [];
    if (saveForFuture) {
      const found = await skusFor(lines.map((l) => l.sku ?? '').filter(Boolean));
      const done = new Set<string>();
      for (const [i, lineId] of lineIds.entries()) {
        const line = byId.get(lineId);
        const k = upper(line?.sku);
        if (!k || done.has(k)) continue;
        done.add(k);
        const sku = found.get(k);
        if (!sku) {
          notInCatalog.push(line?.sku ?? '');
          continue;
        }
        const h = headingFor(lineId);
        const data: Record<string, unknown> = { bomSortOrder: (i + 1) * 10 };
        if (h !== undefined) data.bomGroup = h;
        await updateSku(sku, data, req.user!.sub, 'Saved from an order’s Bill of Materials');
        catalogUpdated++;
      }
    }

    await prisma.orderEvent.create({
      data: {
        orderId: id,
        action: 'order.bomArranged',
        actorId: req.user!.sub,
        detail: { vendor, lines: lineIds.length, saveForFuture, catalogUpdated } as object,
      },
    });
    return { ok: true, catalogUpdated, notInCatalog };
  });

  /**
   * "Use this for all future orders too": copy one line's correction to its part.
   *
   *   * vendorNotes → Sku.bomNote, printed on the part's line on every order locked
   *     from now on.
   *   * bomGroup    → Sku.bomGroup.
   *   * unitCost    → the part's catalog cost (Sku and the dated ProductCost history),
   *     or — on a second-vendor line — what that second vendor charges. Catalog cost
   *     drives every future proposal's margin, so that one needs PRODUCTS_ADMIN.
   *
   * Orders already locked are not touched; each keeps its own snapshot.
   */
  app.post('/orders/procurement/:lineId/save-default', handoff, async (req) => {
    const { lineId } = req.params as { lineId: string };
    const parsed = SaveDefaultBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Choose what to save.');
    const fields = new Set(parsed.data.fields);

    const line = await prisma.procurementLine.findUnique({ where: { id: lineId } });
    if (!line) throw new NotFoundError('Bill of Materials line not found');
    if (!line.sku) throw new ValidationError('This line has no part number to save against.');
    const sku = (await skusFor([line.sku])).get(upper(line.sku));
    if (!sku)
      throw new ValidationError(
        `${line.sku} is not in the SKU master, so there is nowhere to save it. Add it under Catalog first.`,
      );

    const data: Record<string, unknown> = {};
    const saved: string[] = [];
    if (fields.has('vendorNotes')) {
      data.bomNote = (line.vendorNotes ?? '').trim() || null;
      saved.push('BOM note');
    }
    if (fields.has('bomGroup')) {
      data.bomGroup = normalizeHeading(line.bomGroup);
      saved.push('heading');
    }
    let productCost: { productId: string; unitCost: bigint } | null = null;
    if (fields.has('unitCost')) {
      if (line.unitCostMinor == null) throw new ValidationError('This line has no cost to save.');
      if (line.secondaryOfSku) {
        // The line's fee basis travels with its figure: a per-order fee saved as a
        // per-unit one would multiply it on every future order.
        data.secondaryVendorCostMinor = line.unitCostMinor;
        data.processingFeeBasis = line.costPerOrder ? 'PER_ORDER' : 'PER_UNIT';
        saved.push(`${vendorOf(line.vendor)}’s Repackaging Service Fee`);
      } else {
        if (!can(req.user!.role, Permission.PRODUCTS_ADMIN))
          throw new ForbiddenError(
            'Saving a cost to the catalog changes every future proposal’s margin, so it needs a catalog admin.',
          );
        data.unitCostMinor = line.unitCostMinor;
        saved.push('catalog cost');
        const product = await prisma.product.findUnique({
          where: { sku: sku.part },
          select: { id: true },
        });
        if (product) productCost = { productId: product.id, unitCost: BigInt(line.unitCostMinor) };
      }
    }

    await updateSku(sku, data, req.user!.sub, 'Saved from an order’s Bill of Materials');
    // A cost edit also lands in the dated cost history, as the catalog editor does, so
    // the two records of a part's cost cannot drift apart.
    if (productCost)
      await prisma.productCost.create({
        data: {
          ...productCost,
          currency: 'USD',
          effectiveDate: new Date(),
          createdById: req.user!.sub,
        },
      });
    await prisma.orderEvent.create({
      data: {
        orderId: line.orderId,
        action: 'order.bomSavedAsDefault',
        actorId: req.user!.sub,
        detail: { part: sku.part, saved } as object,
      },
    });
    return { ok: true, part: sku.part, saved };
  });
}

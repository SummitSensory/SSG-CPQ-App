import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import { reassignSkuVendor } from '../handoff/vendorReassign.js';
import { recordRevision, skuSnapshot } from '../lib/revisions.js';

const SkuBody = z.object({
  part: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  unitPriceMinor: z.number().int().nonnegative().default(0),
  unitCostMinor: z.number().int().nonnegative().default(0),
  weightLbs: z.number().nonnegative().default(0),
  category: z.string().trim().max(60).default('OTHER'),
  manufacturer: z.string().trim().max(160).nullish(),
  proposalGroup: z.string().trim().max(120).optional(),
  active: z.boolean().default(true),
  overrideAllowed: z.boolean().default(false),
  /** Builder default quantity; null = no default. */
  defaultQty: z.number().int().min(0).max(9999).nullish(),
  /** Where to buy this part — becomes a "Buy" link on the Bill of Materials. */
  productUrl: z.string().trim().url().max(600).nullish(),
  requiresPowderColor: z.boolean().optional(),
  /** Packaging bag the part ships in, e.g. "Bag 7". */
  packagingBag: z.string().trim().max(60).nullish(),
});

// One import row; prices may arrive as dollars (unitPrice) or minor (unitPriceMinor).
const ImportRow = z.object({
  part: z.string().trim().min(1),
  description: z.string().trim().optional(),
  unitPrice: z.union([z.number(), z.string()]).optional(),
  unitPriceMinor: z.number().optional(),
  unitCost: z.union([z.number(), z.string()]).optional(),
  unitCostMinor: z.number().optional(),
  weightLbs: z.union([z.number(), z.string()]).optional(),
  category: z.string().trim().optional(),
  manufacturer: z.string().trim().optional(),
  proposalGroup: z.string().trim().optional(),
  overrideAllowed: z.union([z.boolean(), z.string(), z.number()]).optional(),
  defaultQty: z.union([z.number(), z.string()]).optional(),
  productUrl: z.string().trim().optional(),
  requiresPowderColor: z.union([z.boolean(), z.string(), z.number()]).optional(),
  packagingBag: z.string().trim().optional(),
});
const toMinor = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const num = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return isFinite(num) ? Math.round(num * 100) : 0;
};
const toBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['y', 'yes', 'true', '1', 'x'].includes(
    String(v ?? '')
      .trim()
      .toLowerCase(),
  );
};
const toNum = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const num = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return isFinite(num) ? num : 0;
};

/**
 * Export column order, matched to the importer's recognised columns so a file
 * this route writes re-imports without being touched. `active` is the one
 * read-only column — see the note on `/skus/export`.
 */
const EXPORT_COLUMNS = [
  'part',
  'description',
  'unitPrice',
  'unitCost',
  'weightLbs',
  'category',
  'manufacturer',
  'proposalGroup',
  'packagingBag',
  'productUrl',
  'overrideAllowed',
  'defaultQty',
  'requiresPowderColor',
  'active',
] as const;

/** SKU/pricing master: list, in-app editor CRUD, and bulk Excel/CSV import (upsert by part#). */
export function registerSkuRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/skus', read, async (req) => {
    const { q, category, page = '1', pageSize = '50' } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (q)
      where.OR = [
        { part: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    if (category) where.category = category;
    const take = Math.min(500, parseInt(pageSize, 10) || 50);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;
    const [items, total] = await Promise.all([
      prisma.sku.findMany({ where, orderBy: { part: 'asc' }, take, skip }),
      prisma.sku.count({ where }),
    ]);
    return { items, total, page: parseInt(page, 10) || 1, pageSize: take };
  });

  /**
   * The parts a rep may substitute in the proposal builder. Membership is a
   * catalog decision (`overrideAllowed`), never the builder's — so pre-approval
   * is administered in one place and audited with the rest of the SKU master.
   */
  /**
   * Everything the Adventure Series builder needs to know about a part before a
   * rep answers anything: whether the part may be substituted, and the quantity
   * the field should start at. One call so the builder never renders half-informed.
   */
  app.get('/skus/builder-meta', read, async () => {
    try {
      const items = await prisma.sku.findMany({
        where: { active: true, OR: [{ overrideAllowed: true }, { defaultQty: { not: null } }] },
        select: { part: true, description: true, overrideAllowed: true, defaultQty: true },
        orderBy: { part: 'asc' },
      });
      return { items };
    } catch (e) {
      // Migration 0024/0025 not deployed yet: nothing is overridable and nothing
      // has a default, which is the safe answer rather than a broken builder.
      if ((e as { code?: string }).code !== 'P2022') throw e;
      return { items: [] };
    }
  });

  app.get('/skus/overridable', read, async () => {
    try {
      const items = await prisma.sku.findMany({
        where: { overrideAllowed: true, active: true },
        select: { part: true, description: true },
        orderBy: { part: 'asc' },
      });
      return { items };
    } catch (e) {
      // Migration 0024 not deployed yet — no part is overridable, which is the
      // safe answer. The builder then shows every part number as fixed.
      if ((e as { code?: string }).code !== 'P2022') throw e;
      return { items: [] };
    }
  });

  /**
   * The SKU master as plain rows, in the exact column names and order the
   * importer below reads. Export, edit a column in Excel, re-import: the round
   * trip is the reason the shapes are pinned together, so keep `EXPORT_COLUMNS`
   * and the `has(raw, …)` checks in `/skus/import` in step.
   *
   * Prices are dollars with two decimals, built from integer minor units — Excel
   * mangles nothing and the importer's `toMinor` reads them straight back.
   *
   * `active` is exported for visibility but is NOT an import column (ImportRow
   * strips it). Status changes go through the app or the missing-parts review.
   */
  app.get('/skus/export', read, async (req) => {
    const { q, category } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (q)
      where.OR = [
        { part: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    if (category) where.category = category;

    const rows = await prisma.sku.findMany({ where, orderBy: { part: 'asc' } });
    const dollars = (minor: number) => (Math.round(minor) / 100).toFixed(2);

    return {
      exportedAt: new Date().toISOString(),
      count: rows.length,
      columns: EXPORT_COLUMNS,
      items: rows.map((s) => ({
        part: s.part,
        description: s.description,
        unitPrice: dollars(s.unitPriceMinor),
        unitCost: dollars(s.unitCostMinor),
        weightLbs: s.weightLbs,
        category: s.category,
        manufacturer: s.manufacturer ?? '',
        proposalGroup: s.proposalGroup ?? '',
        packagingBag: s.packagingBag ?? '',
        productUrl: s.productUrl ?? '',
        overrideAllowed: s.overrideAllowed ? 'true' : 'false',
        defaultQty: s.defaultQty == null ? '' : s.defaultQty,
        requiresPowderColor: s.requiresPowderColor ? 'true' : 'false',
        active: s.active ? 'true' : 'false',
      })),
    };
  });

  app.post('/skus', admin, async (req, reply) => {
    const parsed = SkuBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.sku.findUnique({ where: { part: parsed.data.part } });
    if (existing) throw new ValidationError('A SKU with that part number already exists.');
    const sku = await prisma.sku.create({
      data: { ...parsed.data, proposalGroup: parsed.data.proposalGroup ?? null },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'sku.create',
      entity: 'Sku',
      entityId: sku.id,
    });
    return reply.status(201).send(sku);
  });

  app.patch('/skus/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SkuBody.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.sku.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('SKU not found');
    const sku = await prisma.sku.update({ where: { id }, data: parsed.data });

    // Re-sourcing a part is not only a catalog fact: the orders already sold still
    // list it under the old vendor, on a sheet nobody has sent yet. Those lines move
    // with it; a submitted sheet is reported back instead, for someone to unlock.
    const moved =
      parsed.data.manufacturer !== undefined &&
      (sku.manufacturer ?? '') !== (existing.manufacturer ?? '')
        ? await reassignSkuVendor(sku.part, sku.manufacturer, req.user!.sub)
        : null;

    await recordRevision({
      entity: 'Sku',
      entityId: id,
      label: sku.part,
      action: 'update',
      actorId: req.user!.sub,
      before: skuSnapshot(existing as unknown as Record<string, unknown>),
      after: skuSnapshot(sku as unknown as Record<string, unknown>),
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'sku.update',
      entity: 'Sku',
      entityId: id,
      ...(moved ? { details: { vendorReassign: moved } } : {}),
    });
    return { ...sku, vendorReassign: moved };
  });

  app.delete('/skus/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.sku.delete({ where: { id } }).catch(() => {
      throw new NotFoundError('SKU not found');
    });
    return reply.status(204).send();
  });

  /**
   * Bulk import, matched on part number.
   *
   * Overwrite is COLUMN-WISE: only the columns actually present in the file are
   * written, so a sheet of `part,unitCost` reprices the catalog and leaves names,
   * categories, weights and vendors untouched. A blank cell in a column that IS
   * present is a real value (it clears the field) — an absent column is not.
   *
   * Nothing is ever deleted. Parts in the catalog but absent from the file come
   * back as `missing` for review; only `missingAction: 'deactivate'` acts on them.
   */
  app.post('/skus/import', admin, async (req, reply) => {
    const body = z
      .object({
        dryRun: z.boolean().default(false),
        missingAction: z.enum(['leave', 'deactivate']).default('leave'),
        rows: z.array(z.record(z.unknown())).min(1).max(5000),
      })
      .safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);

    const issues: { row: number; part: string; message: string }[] = [];

    /**
     * What happened to each row, so the import can be checked afterwards.
     *
     * Counts alone answer "did it work" and not "did MY part go in", which is the
     * question actually asked when a price looks wrong the week after. Every row that
     * reaches the write loop lands here with its outcome, including the ones that
     * failed — a row that throws no longer takes the rest of the file down with it.
     */
    const results: {
      part: string;
      row: number;
      outcome: 'created' | 'updated' | 'unchanged' | 'failed';
      columns: string[];
      message?: string;
    }[] = [];
    type Row = { part: string; data: Record<string, unknown>; columns: string[]; row: number };
    const clean: Row[] = [];
    const has = (raw: Record<string, unknown>, ...keys: string[]) =>
      keys.some((k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined);

    body.data.rows.forEach((raw, i) => {
      const p = ImportRow.safeParse(raw);
      if (!p.success) {
        // Keep whatever part number the row carried, even though the row is unusable:
        // "row 47 failed" sends someone counting lines in Excel, "6820H-LP failed"
        // does not.
        issues.push({
          row: i + 1,
          part: typeof raw.part === 'string' ? raw.part.trim() : '',
          message: p.error.issues[0]?.message || 'invalid row',
        });
        return;
      }
      const d = p.data;
      const data: Record<string, unknown> = {};
      const columns: string[] = [];
      if (has(raw, 'description')) {
        data.description = (d.description || '').trim() || d.part.trim();
        columns.push('description');
      }
      if (has(raw, 'unitPrice', 'unitPriceMinor')) {
        data.unitPriceMinor =
          d.unitPriceMinor != null ? Math.round(d.unitPriceMinor) : toMinor(d.unitPrice);
        columns.push('unitPrice');
      }
      if (has(raw, 'unitCost', 'unitCostMinor')) {
        data.unitCostMinor =
          d.unitCostMinor != null ? Math.round(d.unitCostMinor) : toMinor(d.unitCost);
        columns.push('unitCost');
      }
      if (has(raw, 'weightLbs')) {
        data.weightLbs = toNum(d.weightLbs);
        columns.push('weightLbs');
      }
      if (has(raw, 'category')) {
        data.category = (d.category || 'OTHER').trim();
        columns.push('category');
      }
      if (has(raw, 'manufacturer')) {
        data.manufacturer = d.manufacturer ? d.manufacturer.trim() : null;
        columns.push('manufacturer');
      }
      if (has(raw, 'proposalGroup')) {
        data.proposalGroup = d.proposalGroup ? d.proposalGroup.trim() : null;
        columns.push('proposalGroup');
      }
      if (has(raw, 'overrideAllowed')) {
        data.overrideAllowed = toBool(d.overrideAllowed);
        columns.push('overrideAllowed');
      }
      if (has(raw, 'requiresPowderColor')) {
        data.requiresPowderColor = toBool(d.requiresPowderColor);
        columns.push('requiresPowderColor');
      }
      // Blank clears the bag label rather than storing an empty string.
      if (has(raw, 'packagingBag')) {
        data.packagingBag = (d.packagingBag ?? '').trim() || null;
        columns.push('packagingBag');
      }
      // A blank clears the link; anything else must be a real URL, so a typo can't
      // become an unclickable "link" on a purchasing document.
      if (has(raw, 'productUrl')) {
        const u = (d.productUrl ?? '').trim();
        if (u && !/^https?:\/\//i.test(u))
          issues.push({
            row: i + 1,
            message: `${d.part}: productUrl must start with http:// or https://`,
          });
        else {
          data.productUrl = u || null;
          columns.push('productUrl');
        }
      }
      if (has(raw, 'defaultQty')) {
        // Blank clears the default; a number sets it. 0 is a real value meaning
        // "offer this part but start it at none".
        data.defaultQty =
          d.defaultQty === '' || d.defaultQty == null
            ? null
            : Math.max(0, Math.round(toNum(d.defaultQty)));
        columns.push('defaultQty');
      }
      clean.push({ part: d.part.trim(), data, columns, row: i + 1 });
    });

    const parts = clean.map((c) => c.part);
    const existing = await prisma.sku.findMany({
      where: { part: { in: parts } },
      select: { part: true },
    });
    const known = new Set(existing.map((e) => e.part));
    // Any part the file leaves out — the review list.
    const absent = await prisma.sku.findMany({
      where: { part: { notIn: parts.length ? parts : ['\u0000'] }, active: true },
      select: { part: true, description: true },
      orderBy: { part: 'asc' },
    });
    const columnsSeen = [...new Set(clean.flatMap((c) => c.columns))];
    const plan = {
      create: clean.filter((c) => !known.has(c.part)).length,
      update: clean.filter((c) => known.has(c.part)).length,
      columns: columnsSeen,
      missing: absent.map((a) => ({ part: a.part, name: a.description })),
    };

    if (body.data.dryRun)
      return { dryRun: true, valid: issues.length === 0, willUpsert: clean.length, issues, plan };

    let created = 0,
      updated = 0;
    // Every part the file re-sourced, so the importer can say which live orders moved.
    const reassigned: NonNullable<Awaited<ReturnType<typeof reassignSkuVendor>>>[] = [];
    for (const c of clean) {
      // Each row stands on its own. A single part that violates a constraint used to
      // throw out of the loop, leaving the file half applied and the response an error
      // with no account of what had already been written.
      try {
        if (known.has(c.part)) {
          if (Object.keys(c.data).length) {
            const before = await prisma.sku.findUnique({
              where: { part: c.part },
              select: { manufacturer: true },
            });
            await prisma.sku.update({ where: { part: c.part }, data: c.data });
            if (
              c.data.manufacturer !== undefined &&
              ((c.data.manufacturer as string | null) ?? '') !== (before?.manufacturer ?? '')
            ) {
              const r = await reassignSkuVendor(
                c.part,
                c.data.manufacturer as string | null,
                req.user!.sub,
              );
              if (r) reassigned.push(r);
            }
            results.push({ part: c.part, row: c.row, outcome: 'updated', columns: c.columns });
          } else {
            // The part matched but the file carried no column for it: nothing to write,
            // and saying so is more honest than counting it as an update.
            results.push({
              part: c.part,
              row: c.row,
              outcome: 'unchanged',
              columns: [],
              message: 'The file had no columns for this part beyond the part number.',
            });
          }
          updated++;
        } else {
          // A new part still needs the non-null basics, whether the file gave them or not.
          await prisma.sku.create({
            data: {
              part: c.part,
              description: (c.data.description as string) ?? c.part,
              category: (c.data.category as string) ?? 'OTHER',
              unitPriceMinor: (c.data.unitPriceMinor as number) ?? 0,
              unitCostMinor: (c.data.unitCostMinor as number) ?? 0,
              weightLbs: (c.data.weightLbs as number) ?? 0,
              manufacturer: (c.data.manufacturer as string | null) ?? null,
              proposalGroup: (c.data.proposalGroup as string | null) ?? null,
              overrideAllowed: (c.data.overrideAllowed as boolean) ?? false,
              defaultQty: (c.data.defaultQty as number | null) ?? null,
              productUrl: (c.data.productUrl as string | null) ?? null,
              requiresPowderColor: (c.data.requiresPowderColor as boolean) ?? false,
              packagingBag: (c.data.packagingBag as string | null) ?? null,
            },
          });
          created++;
          results.push({ part: c.part, row: c.row, outcome: 'created', columns: c.columns });
        }
      } catch (err) {
        // Constraint violations, a bad enum, a value too long. Reported against the
        // part so it can be fixed and re-uploaded on its own.
        results.push({
          part: c.part,
          row: c.row,
          outcome: 'failed',
          columns: c.columns,
          message: err instanceof Error ? err.message.split('\n').pop()?.trim() : String(err),
        });
      }
    }
    const failed = results.filter((r) => r.outcome === 'failed').length;
    // The counts have to describe what actually happened, not what was attempted.
    updated = results.filter((r) => r.outcome === 'updated' || r.outcome === 'unchanged').length;
    created = results.filter((r) => r.outcome === 'created').length;

    let deactivated = 0;
    if (body.data.missingAction === 'deactivate' && absent.length) {
      const r = await prisma.sku.updateMany({
        where: { part: { in: absent.map((a) => a.part) } },
        data: { active: false },
      });
      deactivated = r.count;
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: 'sku.import',
      details: {
        created,
        updated,
        deactivated,
        failed,
        columns: columnsSeen,
        ...(reassigned.length ? { vendorReassign: reassigned } : {}),
      },
    });
    return reply.status(201).send({
      valid: issues.length === 0 && failed === 0,
      created,
      updated,
      deactivated,
      failed,
      issues,
      // Row by row, so the person who ran it can see their own part in the list.
      results,
      plan,
    });
  });
}

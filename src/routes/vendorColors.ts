/**
 * Vendor colours — administration.
 *
 * Lives with the vendor, because the chart belongs to the vendor: Resilite publish
 * one vinyl list and every Resilite product picks from it. Administration →
 * Manufacturers → Colours.
 *
 * Three things are maintained here:
 *   * palettes  — one per vendor per finish ("2026 Vinyl Chart", vinyl)
 *   * colours   — the named entries on a chart, with the vendor's own code
 *   * specs     — which product takes how many colours (1–7) from which chart
 *
 * A fourth endpoint, /vendor-colors/spec, is what the proposal editor and the Bill
 * of Materials ask "does this line take colours, and which?".
 *
 * Reading is CATALOG_READ, because the proposal editor has to offer the list.
 * Writing is PRODUCTS_ADMIN, same as the rest of the catalog.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import { MAX_COLOR_SLOTS, specForLine } from '../vendorColors/service.js';

const FINISHES = ['POWDER_COAT', 'VINYL', 'PAINT', 'OTHER'] as const;

const PaletteInput = z.object({
  name: z.string().trim().min(2).max(120),
  finishType: z.enum(FINISHES).optional(),
  notes: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/** Money in minor units. Negative is refused: a colour discount is a price change. */
const upcharge = z.number().int().min(0).max(100_000_00).nullish();

const ColorInput = z.object({
  name: z.string().trim().min(1).max(120),
  vendorCode: z.string().trim().max(60).nullish(),
  upchargeMinor: upcharge,
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

const SpecInput = z
  .object({
    paletteId: z.string().trim().min(1),
    productId: z.string().trim().min(1).nullish(),
    sku: z.string().trim().max(80).nullish(),
    slotCount: z.number().int().min(1).max(MAX_COLOR_SLOTS),
    required: z.boolean().optional(),
    slotUpchargeMinor: upcharge,
    slotLabels: z.array(z.string().trim().max(60)).max(MAX_COLOR_SLOTS).nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .refine((d) => !!d.productId !== !!(d.sku && d.sku.trim()), {
    message: 'Attach the colours to a catalog product or to a part number, not both.',
  });

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function registerVendorColorRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  /** Every palette for one vendor, with its colours and what points at it. */
  app.get('/manufacturers/:id/color-palettes', read, async (req) => {
    const { id } = req.params as { id: string };
    const mfr = await prisma.manufacturer.findUnique({ where: { id }, select: { name: true } });
    if (!mfr) throw new NotFoundError('That manufacturer no longer exists');

    const palettes = await prisma.vendorColorPalette.findMany({
      where: { manufacturerId: id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        colors: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        specs: { orderBy: { createdAt: 'asc' } },
      },
    });

    // Product names for the specs, so the screen can say "Wall Pad 2x6" rather
    // than a cuid. One query for the sheet, not one per row.
    const productIds = palettes.flatMap((p) =>
      p.specs.map((s) => s.productId).filter((v): v is string => !!v),
    );
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: [...new Set(productIds)] } },
          select: { id: true, sku: true, name: true },
        })
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    return {
      manufacturer: { id, name: mfr.name },
      palettes: palettes.map((p) => ({
        id: p.id,
        name: p.name,
        finishType: p.finishType,
        notes: p.notes,
        active: p.active,
        sortOrder: p.sortOrder,
        colors: p.colors.map((c) => ({
          id: c.id,
          name: c.name,
          vendorCode: c.vendorCode,
          upchargeMinor: c.upchargeMinor,
          sortOrder: c.sortOrder,
          active: c.active,
        })),
        specs: p.specs.map((s) => ({
          id: s.id,
          productId: s.productId,
          sku: s.sku,
          productSku: s.productId ? (byId.get(s.productId)?.sku ?? null) : null,
          productName: s.productId ? (byId.get(s.productId)?.name ?? null) : null,
          slotCount: s.slotCount,
          required: s.required,
          slotUpchargeMinor: s.slotUpchargeMinor,
          slotLabels: s.slotLabels ?? null,
          notes: s.notes,
        })),
      })),
    };
  });

  /**
   * Products this vendor supplies, so a spec is attached by picking rather than by
   * typing a part number. Both links count: the catalog's sourcing rows, and the
   * flat SKU master's manufacturer name, which is the only link a generated part has.
   */
  app.get('/manufacturers/:id/color-targets', read, async (req) => {
    const { id } = req.params as { id: string };
    const { q = '' } = req.query as Record<string, string>;
    const mfr = await prisma.manufacturer.findUnique({ where: { id }, select: { name: true } });
    if (!mfr) throw new NotFoundError('That manufacturer no longer exists');
    const term = q.trim();

    const sourced = await prisma.productSourcing.findMany({
      where: {
        manufacturerId: id,
        ...(term
          ? {
              product: {
                OR: [
                  { name: { contains: term, mode: 'insensitive' as const } },
                  { sku: { contains: term, mode: 'insensitive' as const } },
                ],
              },
            }
          : {}),
      },
      select: { product: { select: { id: true, sku: true, name: true } } },
      take: 400,
    });

    const skus = await prisma.sku.findMany({
      where: {
        manufacturer: { equals: mfr.name, mode: 'insensitive' },
        ...(term
          ? {
              OR: [
                { part: { contains: term, mode: 'insensitive' as const } },
                { description: { contains: term, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { part: true, description: true },
      orderBy: { part: 'asc' },
      take: 400,
    });

    return {
      products: sourced
        .map((s) => s.product)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
      parts: skus.map((s) => ({ sku: s.part, description: s.description })),
    };
  });

  app.post('/manufacturers/:id/color-palettes', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PaletteInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid palette');
    const d = parsed.data;
    const mfr = await prisma.manufacturer.findUnique({ where: { id }, select: { name: true } });
    if (!mfr) throw new NotFoundError('That manufacturer no longer exists');

    const dupe = await prisma.vendorColorPalette.findFirst({
      where: { manufacturerId: id, name: { equals: d.name, mode: 'insensitive' } },
    });
    if (dupe) throw new ValidationError(`${mfr.name} already has a palette called ${d.name}.`);

    const last = await prisma.vendorColorPalette.findFirst({
      where: { manufacturerId: id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const p = await prisma.vendorColorPalette.create({
      data: {
        manufacturerId: id,
        name: d.name,
        finishType: d.finishType ?? 'VINYL',
        notes: blankToNull(d.notes),
        active: d.active ?? true,
        sortOrder: d.sortOrder ?? (last?.sortOrder ?? 0) + 10,
        createdById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.palette.create',
      entity: 'VendorColorPalette',
      entityId: p.id,
      details: { vendor: mfr.name, name: p.name, finishType: p.finishType },
    });
    return reply.status(201).send(p);
  });

  app.patch('/color-palettes/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = PaletteInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid palette');
    const d = parsed.data;
    const existing = await prisma.vendorColorPalette.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That palette no longer exists');

    if (d.name && d.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupe = await prisma.vendorColorPalette.findFirst({
        where: {
          manufacturerId: existing.manufacturerId,
          name: { equals: d.name, mode: 'insensitive' },
          id: { not: id },
        },
      });
      if (dupe) throw new ValidationError(`This vendor already has a palette called ${d.name}.`);
    }

    const p = await prisma.vendorColorPalette.update({
      where: { id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.finishType ? { finishType: d.finishType } : {}),
        ...(d.notes !== undefined ? { notes: blankToNull(d.notes) } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.palette.update',
      entity: 'VendorColorPalette',
      entityId: id,
      details: { name: p.name },
    });
    return p;
  });

  /**
   * A palette is never deleted out from under a product — that would leave lines
   * quoting colours from a chart nobody can name. Deactivate instead, which stops
   * it being offered and leaves every existing selection readable.
   */
  app.delete('/color-palettes/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.vendorColorPalette.findUnique({
      where: { id },
      include: { _count: { select: { specs: true, colors: true } } },
    });
    if (!existing) throw new NotFoundError('That palette no longer exists');
    if (existing._count.specs)
      throw new ConflictError(
        `${existing.name} is used by ${existing._count.specs} product${existing._count.specs === 1 ? '' : 's'}. Remove those first, or deactivate the palette instead.`,
      );
    await prisma.vendorColorPalette.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.palette.delete',
      entity: 'VendorColorPalette',
      entityId: id,
      details: { name: existing.name, colors: existing._count.colors },
    });
    return reply.status(204).send();
  });

  // ---------------- Colours on a chart ----------------

  app.post('/color-palettes/:id/colors', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ColorInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid colour');
    const d = parsed.data;
    const palette = await prisma.vendorColorPalette.findUnique({ where: { id } });
    if (!palette) throw new NotFoundError('That palette no longer exists');

    const dupe = await prisma.vendorColor.findFirst({
      where: { paletteId: id, name: { equals: d.name, mode: 'insensitive' } },
    });
    if (dupe) throw new ValidationError(`${d.name} is already on this palette.`);

    const last = await prisma.vendorColor.findFirst({
      where: { paletteId: id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const c = await prisma.vendorColor.create({
      data: {
        paletteId: id,
        name: d.name,
        vendorCode: blankToNull(d.vendorCode),
        upchargeMinor: d.upchargeMinor ?? null,
        sortOrder: d.sortOrder ?? (last?.sortOrder ?? 0) + 10,
        active: d.active ?? true,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.color.create',
      entity: 'VendorColor',
      entityId: c.id,
      details: { palette: palette.name, name: c.name },
    });
    return reply.status(201).send(c);
  });

  app.patch('/vendor-colors/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ColorInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid colour');
    const d = parsed.data;
    const existing = await prisma.vendorColor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That colour no longer exists');

    if (d.name && d.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupe = await prisma.vendorColor.findFirst({
        where: {
          paletteId: existing.paletteId,
          name: { equals: d.name, mode: 'insensitive' },
          id: { not: id },
        },
      });
      if (dupe) throw new ValidationError(`${d.name} is already on this palette.`);
    }

    const c = await prisma.vendorColor.update({
      where: { id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.vendorCode !== undefined ? { vendorCode: blankToNull(d.vendorCode) } : {}),
        ...(d.upchargeMinor !== undefined ? { upchargeMinor: d.upchargeMinor ?? null } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.color.update',
      entity: 'VendorColor',
      entityId: id,
      details: { name: c.name },
    });
    return c;
  });

  /**
   * Deleting a colour does not disturb a line that already carries it: selections
   * store the name and code alongside the id, so a historic sheet still reads the
   * same. Deactivating is still the kinder move for a discontinued colour, since it
   * keeps the chart honest about what was once offered.
   */
  app.delete('/vendor-colors/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.vendorColor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That colour no longer exists');
    await prisma.vendorColor.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.color.delete',
      entity: 'VendorColor',
      entityId: id,
      details: { name: existing.name },
    });
    return reply.status(204).send();
  });

  /**
   * Paste a vendor's chart. One colour per line, in any of:
   *
   *     Royal Blue
   *     Royal Blue, RB-124
   *     Royal Blue, RB-124, 25.00
   *
   * Tab- and comma-separated both work, so a paste out of a PDF chart or a
   * spreadsheet column lands the same way. Existing colours are updated, not
   * duplicated; order follows the paste. dryRun reports what would happen.
   */
  app.post('/color-palettes/:id/colors/import', admin, async (req) => {
    const Body = z.object({
      text: z.string().max(200_000),
      dryRun: z.boolean().optional(),
      /** Deactivate colours on the chart that the paste does not mention. */
      retireMissing: z.boolean().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Paste the chart as text.');
    const { id } = req.params as { id: string };
    const palette = await prisma.vendorColorPalette.findUnique({
      where: { id },
      include: { colors: true },
    });
    if (!palette) throw new NotFoundError('That palette no longer exists');

    const rows: { name: string; vendorCode: string | null; upchargeMinor: number | null }[] = [];
    const skipped: string[] = [];
    for (const line of parsed.data.text.split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw) continue;
      const cells = raw
        .split(/\t|,/)
        .map((c) => c.trim())
        .filter((c, i) => i === 0 || c !== '');
      const name = cells[0];
      if (!name || name.length > 120) {
        skipped.push(raw.slice(0, 80));
        continue;
      }
      // A header row pasted with the chart: "Colour, Code".
      if (/^(colou?r|name)$/i.test(name)) continue;
      const money = cells[2] ?? '';
      const cleaned = money.replace(/[$,\s]/g, '');
      const upchargeMinor =
        cleaned && /^\d+(\.\d{1,2})?$/.test(cleaned) ? Math.round(Number(cleaned) * 100) : null;
      if (cleaned && upchargeMinor === null) {
        skipped.push(raw.slice(0, 80));
        continue;
      }
      rows.push({ name, vendorCode: cells[1] ? cells[1].slice(0, 60) : null, upchargeMinor });
    }

    const byName = new Map(palette.colors.map((c) => [c.name.toLowerCase(), c]));
    const seen = new Set<string>();
    const created: string[] = [];
    const updated: string[] = [];
    let order = 0;
    for (const r of rows) {
      const key = r.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      order += 10;
      const hit = byName.get(key);
      if (hit) updated.push(r.name);
      else created.push(r.name);
      if (parsed.data.dryRun) continue;
      if (hit) {
        await prisma.vendorColor.update({
          where: { id: hit.id },
          data: {
            name: r.name,
            vendorCode: r.vendorCode ?? hit.vendorCode,
            upchargeMinor: r.upchargeMinor ?? hit.upchargeMinor,
            sortOrder: order,
            active: true,
          },
        });
      } else {
        await prisma.vendorColor.create({
          data: {
            paletteId: id,
            name: r.name,
            vendorCode: r.vendorCode,
            upchargeMinor: r.upchargeMinor,
            sortOrder: order,
          },
        });
      }
    }

    const retired = palette.colors
      .filter((c) => c.active && !seen.has(c.name.toLowerCase()))
      .map((c) => c.name);
    if (parsed.data.retireMissing && !parsed.data.dryRun && retired.length) {
      await prisma.vendorColor.updateMany({
        where: { paletteId: id, name: { in: retired } },
        data: { active: false },
      });
    }

    if (!parsed.data.dryRun)
      await recordAudit({
        actorId: req.user!.sub,
        action: 'vendorColor.import',
        entity: 'VendorColorPalette',
        entityId: id,
        details: {
          palette: palette.name,
          created: created.length,
          updated: updated.length,
          retired: parsed.data.retireMissing ? retired.length : 0,
        },
      });

    return {
      dryRun: !!parsed.data.dryRun,
      created,
      updated,
      skipped,
      retired: parsed.data.retireMissing ? retired : [],
    };
  });

  // ---------------- Which product takes how many colours ----------------

  app.post('/product-color-specs', admin, async (req, reply) => {
    const parsed = SpecInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid colour rule');
    const d = parsed.data;
    const palette = await prisma.vendorColorPalette.findUnique({
      where: { id: d.paletteId },
      include: { manufacturer: { select: { name: true } }, _count: { select: { colors: true } } },
    });
    if (!palette) throw new NotFoundError('That palette no longer exists');
    if (!palette._count.colors)
      throw new ValidationError(
        `${palette.name} has no colours on it yet. Add the chart before attaching products to it.`,
      );

    const sku = blankToNull(d.sku);
    const existing = d.productId
      ? await prisma.productColorSpec.findUnique({ where: { productId: d.productId } })
      : await prisma.productColorSpec.findFirst({
          where: { sku: { equals: sku!, mode: 'insensitive' } },
        });
    if (existing)
      throw new ValidationError(
        'That product already has a colour rule. Edit the existing one rather than adding a second — two rules would make the number of colours a matter of query order.',
      );

    if (d.productId) {
      const product = await prisma.product.findUnique({
        where: { id: d.productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('That product no longer exists');
    }

    const spec = await prisma.productColorSpec.create({
      data: {
        paletteId: d.paletteId,
        productId: d.productId ?? null,
        sku,
        slotCount: d.slotCount,
        required: d.required ?? false,
        slotUpchargeMinor: d.slotUpchargeMinor ?? null,
        slotLabels: d.slotLabels && d.slotLabels.length ? d.slotLabels : undefined,
        notes: blankToNull(d.notes),
        createdById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.spec.create',
      entity: 'ProductColorSpec',
      entityId: spec.id,
      details: {
        vendor: palette.manufacturer.name,
        palette: palette.name,
        target: d.productId ?? sku,
        slotCount: spec.slotCount,
      },
    });
    return reply.status(201).send(spec);
  });

  app.patch('/product-color-specs/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const Body = z.object({
      paletteId: z.string().trim().min(1).optional(),
      slotCount: z.number().int().min(1).max(MAX_COLOR_SLOTS).optional(),
      required: z.boolean().optional(),
      slotUpchargeMinor: upcharge,
      slotLabels: z.array(z.string().trim().max(60)).max(MAX_COLOR_SLOTS).nullish(),
      notes: z.string().trim().max(1000).nullish(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid colour rule');
    const d = parsed.data;
    const existing = await prisma.productColorSpec.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That colour rule no longer exists');

    // A palette may be moved within the same vendor — a product that used to take
    // vinyl now takes powder — but never across vendors, which would quote a
    // customer colours the supplier of that part does not make.
    if (d.paletteId && d.paletteId !== existing.paletteId) {
      const [from, to] = await Promise.all([
        prisma.vendorColorPalette.findUnique({ where: { id: existing.paletteId } }),
        prisma.vendorColorPalette.findUnique({ where: { id: d.paletteId } }),
      ]);
      if (!to) throw new NotFoundError('That palette no longer exists');
      if (from && from.manufacturerId !== to.manufacturerId)
        throw new ValidationError(
          'A product cannot be moved onto another vendor’s palette. Remove the rule and add it under the right vendor.',
        );
    }

    const spec = await prisma.productColorSpec.update({
      where: { id },
      data: {
        // Connected rather than set as a scalar: Prisma's update input is XOR'd
        // between the checked and unchecked shapes, and mixing a scalar foreign key
        // into the checked one does not typecheck.
        ...(d.paletteId ? { palette: { connect: { id: d.paletteId } } } : {}),
        ...(d.slotCount !== undefined ? { slotCount: d.slotCount } : {}),
        ...(d.required !== undefined ? { required: d.required } : {}),
        ...(d.slotUpchargeMinor !== undefined
          ? { slotUpchargeMinor: d.slotUpchargeMinor ?? null }
          : {}),
        // Clearing a Json column is Prisma.DbNull; a bare null means "the JSON value
        // null" and is rejected at runtime.
        ...(d.slotLabels !== undefined
          ? {
              slotLabels: d.slotLabels && d.slotLabels.length ? d.slotLabels : Prisma.DbNull,
            }
          : {}),
        ...(d.notes !== undefined ? { notes: blankToNull(d.notes) } : {}),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.spec.update',
      entity: 'ProductColorSpec',
      entityId: id,
      details: { slotCount: spec.slotCount, required: spec.required },
    });
    return spec;
  });

  app.delete('/product-color-specs/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.productColorSpec.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That colour rule no longer exists');
    await prisma.productColorSpec.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'vendorColor.spec.delete',
      entity: 'ProductColorSpec',
      entityId: id,
      details: { target: existing.productId ?? existing.sku, slotCount: existing.slotCount },
    });
    return reply.status(204).send();
  });

  /**
   * "Does this line take colours, and which?" — asked by the proposal editor per
   * line and by the Bill of Materials per sheet. Returns null when the product
   * takes no colour choice, which is the common case and not an error.
   */
  app.get('/vendor-colors/spec', read, async (req) => {
    const { productId = '', sku = '' } = req.query as Record<string, string>;
    if (!productId && !sku) throw new ValidationError('Give a productId or a sku.');
    return { spec: await specForLine({ productId: productId || null, sku: sku || null }) };
  });
}

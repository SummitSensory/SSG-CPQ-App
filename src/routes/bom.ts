import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import {
  listSections,
  patchSection,
  confirmSection,
  unlockSection,
  reorderSections,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  submissionBlockers,
  UNASSIGNED,
  pullDealFigures,
} from '../handoff/bomSections.js';
import { dealFigures } from '../handoff/dealFigures.js';
import { sendBom } from '../handoff/bomSend.js';

/**
 * Bill of Materials — per-vendor sections, their questions, and the powder-coat
 * colour palette.
 *
 * Split out of `orders.ts` because the BOM is now its own surface: a section per
 * vendor, each with its own lock, questions, colours and send history. The
 * order-level `/orders/:id/bom` header endpoints stay where they are — they hold
 * the defaults a new section inherits.
 */

const QUESTION_TYPES = [
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
] as const;

const SectionPatchSchema = z.object({
  showPowderColor: z.boolean().optional(),
  showPackagingBag: z.boolean().optional(),
  jobName: z.string().trim().max(240).nullish(),
  shipTo: z.enum(['CUSTOMER', 'SUMMIT']).optional(),
  submittedOn: z.union([z.coerce.date(), z.null()]).optional(),
  deliveryType: z.string().trim().max(120).nullish(),
  powderCoatBrand: z.string().trim().max(120).nullish(),
  shipmentQuote: z.string().trim().max(120).nullish(),
  estimatedTax: z.string().trim().max(120).nullish(),
  /** A named address. Null clears it and falls back to `shipTo`. */
  shipToAddressId: z.string().trim().max(40).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

const SendSchema = z.object({
  to: z.string().trim().min(1),
  cc: z.string().trim().max(500).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20000),
  format: z.enum(['EXCEL', 'PDF', 'BOTH']).default('PDF'),
  includeZeroQty: z.boolean().optional(),
});

const QuestionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  type: z.enum(QUESTION_TYPES).default('TEXT'),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  required: z.boolean().optional(),
});

const QuestionPatchSchema = z.object({
  value: z.string().max(4000).nullish(),
  label: z.string().trim().min(1).max(200).optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const TemplateSchema = z.object({
  vendor: z.string().trim().max(160).nullish(),
  label: z.string().trim().min(1).max(200),
  type: z.enum(QUESTION_TYPES).default('TEXT'),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  helpText: z.string().trim().max(400).nullish(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const BrandSchema = z.object({
  name: z.string().trim().min(1).max(120),
  website: z.string().trim().max(300).nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Apply one brand + typed code to a chosen set of parts on an order. The brand
 * comes from the managed list so it is spelled the same every time; the code is
 * whatever the customer gave us.
 */
const ApplyColorSchema = z.object({
  brandId: z.string().min(1),
  code: z.string().trim().min(1).max(60),
  /** Part numbers to paint. Empty means "every line in this vendor's section". */
  skus: z.array(z.string().trim().min(1)).default([]),
  /**
   * A paint colour group name. The customer chooses a colour per group of parts
   * rather than one for the whole structure, so the group names what gets painted.
   * Resolved from the chart here rather than trusted from the browser, so a stale
   * screen cannot paint a part the chart has since moved.
   */
  group: z.string().trim().max(40).nullish(),
  vendor: z.string().trim().max(160).optional(),
  /** Off by default: a colour already chosen by hand is never overwritten. */
  overwrite: z.boolean().default(false),
});

export function registerBomRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const handoff = { preHandler: requirePermission(Permission.HANDOFF_MANAGE) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  // ------------------------------------------------------------- sections
  app.get('/orders/:id/bom/sections', read, async (req) => {
    const { id } = req.params as { id: string };
    return { sections: await listSections(id, req.user!.sub) };
  });

  /**
   * The deal's freight and tax, read live from monday.
   *
   * Its own endpoint rather than part of the section load: monday being slow or
   * unreachable must not stop an order from opening. The browser asks for these
   * when someone looks at the figures, and the error, if there is one, is reported
   * rather than thrown.
   */
  app.get('/orders/:id/deal-figures', read, async (req) =>
    dealFigures((req.params as { id: string }).id),
  );

  /**
   * Write those figures onto the sections. A figure typed by hand is kept unless
   * `overwrite` is set — a negotiated number should not be undone by a refresh.
   */
  app.post('/orders/:id/deal-figures/pull', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { overwrite?: boolean };
    return pullDealFigures(id, { overwrite: !!b.overwrite }, req.user!.sub);
  });

  // ---------------------------------------------------------- ship-to addresses
  //
  // Where a shipment goes when it is neither the customer's site nor Summit's
  // dock — a job trailer, an installer's warehouse. Kept as records because the
  // same address is used across vendors on one order and across orders, and
  // re-typing it is how two sheets end up disagreeing about where the truck goes.

  const AddressInput = z.object({
    name: z.string().trim().min(1).max(160),
    line1: z.string().trim().max(200).nullish(),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().max(120).nullish(),
    region: z.string().trim().max(80).nullish(),
    postalCode: z.string().trim().max(20).nullish(),
    country: z.string().trim().max(80).nullish(),
    contactName: z.string().trim().max(160).nullish(),
    phone: z.string().trim().max(40).nullish(),
    email: z.string().trim().max(200).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    active: z.boolean().optional(),
  });

  app.get('/ship-to-addresses', read, async (req) => {
    const q = req.query as { includeInactive?: string };
    return prisma.shipToAddress.findMany({
      where: q.includeInactive === 'true' ? {} : { active: true },
      orderBy: { name: 'asc' },
    });
  });

  app.post('/ship-to-addresses', handoff, async (req, reply) => {
    const parsed = AddressInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid address');
    const d = parsed.data;
    const row = await prisma.shipToAddress.create({
      data: {
        name: d.name,
        line1: d.line1 || null,
        line2: d.line2 || null,
        city: d.city || null,
        region: d.region || null,
        postalCode: d.postalCode || null,
        country: d.country || 'USA',
        contactName: d.contactName || null,
        phone: d.phone || null,
        email: d.email || null,
        notes: d.notes || null,
        createdById: req.user!.sub,
      },
    });
    return reply.status(201).send(row);
  });

  app.patch('/ship-to-addresses/:addressId', handoff, async (req) => {
    const { addressId } = req.params as { addressId: string };
    const parsed = AddressInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid address');
    const existing = await prisma.shipToAddress.findUnique({ where: { id: addressId } });
    if (!existing) throw new NotFoundError('Ship-to address not found');
    const d = parsed.data;
    const data: Record<string, unknown> = {};
    for (const k of [
      'name',
      'line1',
      'line2',
      'city',
      'region',
      'postalCode',
      'country',
      'contactName',
      'phone',
      'email',
      'notes',
    ] as const) {
      if (d[k] !== undefined) data[k] = d[k] || null;
    }
    if (d.active !== undefined) data.active = d.active;
    return prisma.shipToAddress.update({ where: { id: addressId }, data });
  });

  /**
   * Retire an address. Never hard-deleted while a section points at it — that
   * would blank the ship-to block on a sheet the vendor already has.
   */
  app.delete('/ship-to-addresses/:addressId', handoff, async (req) => {
    const { addressId } = req.params as { addressId: string };
    const inUse = await prisma.bomVendorSection.count({ where: { shipToAddressId: addressId } });
    if (inUse) {
      return prisma.shipToAddress.update({ where: { id: addressId }, data: { active: false } });
    }
    await prisma.shipToAddress.delete({ where: { id: addressId } });
    return { deleted: addressId };
  });

  app.patch('/bom/sections/:sectionId', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const parsed = SectionPatchSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid change');
    return patchSection(sectionId, parsed.data, req.user!.sub);
  });

  /**
   * Confirm this vendor's BOM has been processed. Refuses while a required
   * question is unanswered or a colour-bearing part has no colour — the point of
   * confirming is that the sheet is complete.
   */
  app.post('/bom/sections/:sectionId/confirm', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const blockers = await submissionBlockers(sectionId);
    if (blockers.length) throw new ValidationError(`Not ready to submit: ${blockers.join('; ')}`);
    return confirmSection(sectionId, req.user!.sub);
  });

  app.get('/bom/sections/:sectionId/blockers', read, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    return { blockers: await submissionBlockers(sectionId) };
  });

  app.post('/bom/sections/:sectionId/unlock', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const b = (req.body || {}) as { reason?: string };
    return unlockSection(sectionId, b.reason ?? '', req.user!.sub);
  });

  app.post('/orders/:id/bom/sections/reorder', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body || {}) as { ids?: string[] };
    if (!Array.isArray(b.ids) || !b.ids.length) throw new ValidationError('ids are required');
    await reorderSections(id, b.ids, req.user!.sub);
    return { sections: await listSections(id) };
  });

  /**
   * Email this vendor's BOM. The attachment is built first: if the document
   * cannot be produced, nothing is sent and the operator is told, rather than a
   * vendor receiving a covering note with no sheet.
   */
  app.post('/bom/sections/:sectionId/send', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid email');
    return sendBom(sectionId, parsed.data, req.user!.sub);
  });

  // ------------------------------------------------------------- questions
  app.post('/bom/sections/:sectionId/questions', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const parsed = QuestionSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
    return addQuestion(sectionId, parsed.data, req.user!.sub);
  });

  app.patch('/bom/questions/:questionId', handoff, async (req) => {
    const { questionId } = req.params as { questionId: string };
    const parsed = QuestionPatchSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid answer');
    return updateQuestion(questionId, parsed.data, req.user!.sub);
  });

  app.delete('/bom/questions/:questionId', handoff, async (req, reply) => {
    const { questionId } = req.params as { questionId: string };
    await deleteQuestion(questionId, req.user!.sub);
    return reply.status(204).send();
  });

  /**
   * Reusable question definitions. A template with no vendor is asked of every
   * section; one with a vendor is asked only of that vendor's. Editing a template
   * never rewrites an answer already given on an order.
   */
  app.get('/bom/question-templates', read, async () =>
    prisma.bomQuestionTemplate.findMany({ orderBy: [{ vendor: 'asc' }, { sortOrder: 'asc' }] }),
  );

  app.post('/bom/question-templates', admin, async (req) => {
    const parsed = TemplateSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
    const d = parsed.data;
    if ((d.type === 'SELECT' || d.type === 'MULTI_SELECT') && !(d.options ?? []).length) {
      throw new ValidationError('A dropdown needs at least one option');
    }
    return prisma.bomQuestionTemplate.create({
      data: {
        vendor: d.vendor?.trim() || null,
        label: d.label,
        type: d.type,
        options: (d.options ?? []) as unknown as object,
        helpText: d.helpText ?? null,
        required: !!d.required,
        sortOrder: d.sortOrder ?? 0,
        active: d.active ?? true,
      },
    });
  });

  app.patch('/bom/question-templates/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = TemplateSchema.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
    const d = parsed.data;
    return prisma.bomQuestionTemplate.update({
      where: { id },
      data: {
        ...(d.vendor !== undefined ? { vendor: d.vendor?.trim() || null } : {}),
        ...(d.label !== undefined ? { label: d.label } : {}),
        ...(d.type !== undefined ? { type: d.type } : {}),
        ...(d.options !== undefined ? { options: d.options as unknown as object } : {}),
        ...(d.helpText !== undefined ? { helpText: d.helpText ?? null } : {}),
        ...(d.required !== undefined ? { required: d.required } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
      },
    });
  });

  app.delete('/bom/question-templates/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.bomQuestionTemplate.delete({ where: { id } });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------- colours
  /**
   * The brand list for the colour picker, plus the codes already used on this
   * deployment so a repeat colour can be picked instead of retyped. The codes are
   * a convenience list built from history — never a validation list.
   */
  app.get('/powder-colors', read, async () => {
    const [brands, used] = await Promise.all([
      prisma.powderColorBrand.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.procurementLine.findMany({
        where: { powderColorCode: { not: null }, powderBrandId: { not: null } },
        select: { powderBrandId: true, powderColorCode: true },
        distinct: ['powderBrandId', 'powderColorCode'],
        orderBy: { powderColorCode: 'asc' },
      }),
    ]);
    return {
      brands: brands.map((b) => ({
        ...b,
        recentCodes: used
          .filter((u) => u.powderBrandId === b.id)
          .map((u) => u.powderColorCode as string),
      })),
    };
  });

  app.post('/powder-colors/brands', admin, async (req) => {
    const parsed = BrandSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid brand');
    const d = parsed.data;
    return prisma.powderColorBrand.create({
      data: {
        name: d.name,
        website: d.website ?? null,
        active: d.active ?? true,
        sortOrder: d.sortOrder ?? 0,
      },
    });
  });

  app.patch('/powder-colors/brands/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = BrandSchema.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid brand');
    const d = parsed.data;
    return prisma.powderColorBrand.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.website !== undefined ? { website: d.website ?? null } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      },
    });
  });

  /**
   * Paint a colour onto specific part numbers on an order.
   *
   * This is the "customer picked Cardinal 5019, and these five parts are the red
   * ones" action. The brand id, the typed code AND the printed text are all
   * written, so an exported sheet still reads correctly even if the brand is later
   * renamed. A line the operator already coloured by hand is left alone unless
   * `overwrite` is set.
   */
  app.post('/orders/:id/bom/apply-color', handoff, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ApplyColorSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const { brandId, code, skus, vendor, overwrite, group } = parsed.data;

    const brand = await prisma.powderColorBrand.findUnique({
      where: { id: brandId },
      select: { id: true, name: true },
    });
    if (!brand) throw new NotFoundError('Powder colour brand not found');

    // The chart decides which parts a group covers.
    let groupSkus: string[] = [];
    if (group) {
      const g = await prisma.paintColorGroup.findFirst({
        where: { name: { equals: group, mode: 'insensitive' } },
        include: { skus: { select: { sku: true } } },
      });
      if (!g) throw new NotFoundError(`There is no paint colour group called ${group}`);
      groupSkus = g.skus.map((x) => x.sku.toUpperCase());
      if (!groupSkus.length) throw new ValidationError(`No part is in group ${g.name} yet.`);
    }

    // A submitted section is frozen — colours included.
    const locked = new Set(
      (
        await prisma.bomVendorSection.findMany({
          where: { orderId: id, status: 'SUBMITTED' },
          select: { vendor: true },
        })
      ).map((s) => s.vendor),
    );

    const lines = await prisma.procurementLine.findMany({
      where: { orderId: id },
      select: { id: true, sku: true, vendor: true, powderColor: true, powderColorCode: true },
    });

    // Both filters may be given; a part then has to satisfy each.
    const wanted = new Set(skus.map((x) => x.toUpperCase()));
    const inGroup = new Set(groupSkus);
    const targets = lines.filter((l) => {
      const v = (l.vendor && l.vendor.trim()) || UNASSIGNED;
      const part = (l.sku || '').toUpperCase();
      if (locked.has(v)) return false;
      if (vendor && v !== vendor) return false;
      if (inGroup.size && !(part && inGroup.has(part))) return false;
      if (wanted.size && !(part && wanted.has(part))) return false;
      if (!overwrite && ((l.powderColorCode || '').trim() || (l.powderColor || '').trim()))
        return false;
      return true;
    });

    const printed = `${brand.name} ${code}`.trim();
    if (targets.length) {
      await prisma.procurementLine.updateMany({
        where: { id: { in: targets.map((t) => t.id) } },
        data: { powderBrandId: brand.id, powderColorCode: code, powderColor: printed },
      });
      await prisma.orderEvent.create({
        data: {
          orderId: id,
          action: 'bom.color.applied',
          actorId: req.user!.sub,
          detail: {
            color: printed,
            brand: brand.name,
            code,
            ...(group ? { group } : {}),
            parts: targets.map((t) => t.sku).filter(Boolean),
            overwrite,
          } as object,
        },
      });
    }
    return {
      applied: targets.length,
      skipped: lines.length - targets.length,
      color: printed,
      lockedVendors: [...locked],
    };
  });
}

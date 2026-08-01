import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import {
  listSections, patchSection, confirmSection, unlockSection, reorderSections,
  addQuestion, updateQuestion, deleteQuestion, submissionBlockers, UNASSIGNED,
} from '../handoff/bomSections.js';
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

const QUESTION_TYPES = ['TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN'] as const;

const SectionPatchSchema = z.object({
  showPowderColor: z.boolean().optional(),
  showPackagingBag: z.boolean().optional(),
  jobName: z.string().trim().max(240).nullish(),
  shipTo: z.enum(['CUSTOMER', 'SUMMIT']).optional(),
  submittedOn: z.union([z.coerce.date(), z.null()]).optional(),
  deliveryType: z.string().trim().max(120).nullish(),
  powderCoatBrand: z.string().trim().max(120).nullish(),
  shipmentQuote: z.string().trim().max(120).nullish(),
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

  app.patch('/bom/sections/:sectionId', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const parsed = SectionPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid change');
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
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid email');
    return sendBom(sectionId, parsed.data, req.user!.sub);
  });

  // ------------------------------------------------------------- questions
  app.post('/bom/sections/:sectionId/questions', handoff, async (req) => {
    const { sectionId } = req.params as { sectionId: string };
    const parsed = QuestionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
    return addQuestion(sectionId, parsed.data, req.user!.sub);
  });

  app.patch('/bom/questions/:questionId', handoff, async (req) => {
    const { questionId } = req.params as { questionId: string };
    const parsed = QuestionPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid answer');
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
    prisma.bomQuestionTemplate.findMany({ orderBy: [{ vendor: 'asc' }, { sortOrder: 'asc' }] }));

  app.post('/bom/question-templates', admin, async (req) => {
    const parsed = TemplateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
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
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid question');
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
      prisma.powderColorBrand.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
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
        recentCodes: used.filter((u) => u.powderBrandId === b.id).map((u) => u.powderColorCode as string),
      })),
    };
  });

  app.post('/powder-colors/brands', admin, async (req) => {
    const parsed = BrandSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid brand');
    const d = parsed.data;
    return prisma.powderColorBrand.create({
      data: { name: d.name, website: d.website ?? null, active: d.active ?? true, sortOrder: d.sortOrder ?? 0 },
    });
  });

  app.patch('/powder-colors/brands/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = BrandSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid brand');
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
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const { brandId, code, skus, vendor, overwrite } = parsed.data;

    const brand = await prisma.powderColorBrand.findUnique({ where: { id: brandId }, select: { id: true, name: true } });
    if (!brand) throw new NotFoundError('Powder colour brand not found');

    // A submitted section is frozen — colours included.
    const locked = new Set(
      (await prisma.bomVendorSection.findMany({
        where: { orderId: id, status: 'SUBMITTED' },
        select: { vendor: true },
      })).map((s) => s.vendor),
    );

    const lines = await prisma.procurementLine.findMany({
      where: { orderId: id },
      select: { id: true, sku: true, vendor: true, powderColor: true, powderColorCode: true },
    });

    const wanted = new Set(skus);
    const targets = lines.filter((l) => {
      const v = (l.vendor && l.vendor.trim()) || UNASSIGNED;
      if (locked.has(v)) return false;
      if (vendor && v !== vendor) return false;
      if (wanted.size && !(l.sku && wanted.has(l.sku))) return false;
      if (!overwrite && ((l.powderColorCode || '').trim() || (l.powderColor || '').trim())) return false;
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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, requireAuth } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { can } from '../authz/rbac.js';
import { ValidationError } from '../lib/errors.js';
import { quote, snapshotQuote, logOverride } from '../pricing/service.js';
import type { PricingInput } from '../pricing/engine.js';

// Money fields arrive as decimal strings and are parsed to bigint minor units.
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/).nullable();
function toMinor(s: string | null): bigint | null {
  if (s === null) return null;
  const [w, fr = ''] = s.split('.');
  return BigInt(w + fr.padEnd(2, '0'));
}

const FeeSchema = z.object({ amount: money, confirmed: z.boolean(), taxable: z.boolean().optional() });

const QuoteSchema = z.object({
  currency: z.string().length(3),
  lines: z.array(z.object({
    ref: z.string(), productId: z.string(), kind: z.string().optional(),
    quantity: z.number().int().positive(),
    unitPrice: money, unitCost: money,
    priceSource: z.string().default('price-list'),
    lineDiscountBps: z.number().int().nonnegative().optional(),
  })).min(1),
  orderDiscounts: z.array(z.object({ amount: money.optional(), bps: z.number().int().optional(), reason: z.string().min(1), authorizedById: z.string().optional(), authorizedRole: z.string().optional() })).optional(),
  fees: z.object({
    freight: FeeSchema.optional(), installation: FeeSchema.optional(),
    travel: FeeSchema.optional(), perDiem: FeeSchema.optional(),
    mileage: z.object({ miles: z.number().nonnegative(), ratePerMile: money, confirmed: z.boolean(), taxable: z.boolean().optional() }).optional(),
    other: z.array(z.object({ label: z.string(), amount: money, confirmed: z.boolean().optional(), taxable: z.boolean().optional() })).optional(),
    creditCardBps: z.number().int().nonnegative().optional(),
  }).optional(),
  tax: z.object({ rateBps: z.number().int().nonnegative(), exempt: z.boolean(), exemptionRef: z.string().optional() }).optional(),
  payment: z.object({ depositBps: z.number().int(), progressBps: z.number().int(), finalBps: z.number().int() }).optional(),
  thresholds: z.object({ minMarginBps: z.number().int().optional(), discountAuthorityBps: z.number().int().optional() }).optional(),
  persist: z.boolean().default(false),
  subjectRef: z.string().optional(),
});

function build(parsed: z.infer<typeof QuoteSchema>): PricingInput {
  return {
    currency: parsed.currency,
    lines: parsed.lines.map((l) => ({ ...l, unitPrice: toMinor(l.unitPrice), unitCost: toMinor(l.unitCost) })),
    orderDiscounts: parsed.orderDiscounts?.map((d) => ({ ...d, amount: d.amount != null ? toMinor(d.amount) ?? undefined : undefined })),
    fees: parsed.fees ? {
      freight: parsed.fees.freight ? { ...parsed.fees.freight, amount: toMinor(parsed.fees.freight.amount) } : undefined,
      installation: parsed.fees.installation ? { ...parsed.fees.installation, amount: toMinor(parsed.fees.installation.amount) } : undefined,
      travel: parsed.fees.travel ? { ...parsed.fees.travel, amount: toMinor(parsed.fees.travel.amount) } : undefined,
      perDiem: parsed.fees.perDiem ? { ...parsed.fees.perDiem, amount: toMinor(parsed.fees.perDiem.amount) } : undefined,
      mileage: parsed.fees.mileage ? { ...parsed.fees.mileage, ratePerMile: toMinor(parsed.fees.mileage.ratePerMile) } : undefined,
      other: parsed.fees.other?.map((o) => ({ ...o, amount: toMinor(o.amount) })),
      creditCardBps: parsed.fees.creditCardBps,
    } : undefined,
    tax: parsed.tax,
    payment: parsed.payment,
    thresholds: parsed.thresholds,
  };
}

/** Serialize bigint fields to strings for JSON transport. */
function serialize(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function registerPricingRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PRICING_READ) };

  app.post('/pricing/quote', read, async (req) => {
    const parsed = QuoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const breakdown = quote(build(parsed.data));

    // Cost & margin are only returned to roles allowed to see them.
    const showCost = can(req.user!.role, Permission.COSTS_READ);
    const showMargin = can(req.user!.role, Permission.MARGINS_READ);
    const out = serialize(breakdown) as Record<string, unknown> & { lines: Array<Record<string, unknown>> };
    if (!showCost) { delete out.totalCost; out.lines.forEach((l) => { delete l.cost; }); }
    if (!showMargin) { delete out.totalMargin; delete out.marginBps; out.lines.forEach((l) => { delete l.margin; delete l.marginBps; }); }

    if (parsed.data.persist) {
      const id = await snapshotQuote(build(parsed.data), breakdown, req.user!.sub, { subjectRef: parsed.data.subjectRef });
      (out as Record<string, unknown>).snapshotId = id;
    }
    return out;
  });

  // Manual override — requires pricing:override + a reason (enforced in service).
  app.post('/pricing/override', { preHandler: requirePermission(Permission.PRICING_OVERRIDE) }, async (req, reply) => {
    const body = req.body as { subjectRef?: string; field?: string; previousValue?: string; newValue?: string; reason?: string };
    if (!body.field || !body.newValue || !body.reason) throw new ValidationError('field, newValue and reason are required');
    await logOverride({
      subjectRef: body.subjectRef,
      field: body.field,
      previousValue: body.previousValue,
      newValue: body.newValue,
      reason: body.reason,
      authorizedById: req.user!.sub,
    });
    return reply.status(201).send({ logged: true });
  });

  app.get('/pricing/snapshots/:ref', { preHandler: requireAuth }, async (req) => {
    const { ref } = req.params as { ref: string };
    if (!can(req.user!.role, Permission.PRICING_READ)) throw new ValidationError('forbidden');
    const { prisma } = await import('../lib/prisma.js');
    return serialize(await prisma.priceSnapshot.findMany({ where: { subjectRef: ref }, orderBy: { createdAt: 'desc' } }));
  });
}

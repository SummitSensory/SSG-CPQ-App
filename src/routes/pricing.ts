import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, requireAuth } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { can } from '../authz/rbac.js';
import { ValidationError, ForbiddenError } from '../lib/errors.js';
import { quote, snapshotQuote, logOverride } from '../pricing/service.js';
import type { PricingInput } from '../pricing/engine.js';
import type { Role } from '../authz/rbac.js';

/** A non-negative integer bps from the environment, or undefined when unset/invalid. */
function envBps(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 10000 ? v : undefined;
}

/**
 * Approval thresholds are the SERVER's, not the caller's. A request may tighten them
 * (a higher margin floor, a lower discount ceiling) but never loosen them: the body
 * used to be the only source, so a client could send `discountAuthorityBps: 10000`
 * — or omit thresholds — and approve its own discount.
 *
 * Configured with PRICING_MIN_MARGIN_BPS and PRICING_DISCOUNT_AUTHORITY_BPS. Unset
 * means no server floor/ceiling, which is what applied before this existed.
 */
export function effectiveThresholds(requested?: {
  minMarginBps?: number;
  discountAuthorityBps?: number;
}): { minMarginBps?: number; discountAuthorityBps?: number } {
  const serverMin = envBps('PRICING_MIN_MARGIN_BPS');
  const serverAuth = envBps('PRICING_DISCOUNT_AUTHORITY_BPS');
  const pick = (
    a: number | undefined,
    b: number | undefined,
    f: (x: number, y: number) => number,
  ) => (a === undefined ? b : b === undefined ? a : f(a, b));
  return {
    minMarginBps: pick(serverMin, requested?.minMarginBps, Math.max),
    discountAuthorityBps: pick(serverAuth, requested?.discountAuthorityBps, Math.min),
  };
}

type Json = Record<string, unknown>;

/**
 * Remove what a role may not see from a serialized breakdown (and, for a stored
 * snapshot, its input). Cost needs COSTS_READ, margin needs MARGINS_READ. A margin
 * finding's message carries the margin figure, so it is reworded rather than left to
 * say in prose what the deleted fields said in numbers.
 */
function redactBreakdown(out: Json, role: Role): void {
  const showCost = can(role, Permission.COSTS_READ);
  const showMargin = can(role, Permission.MARGINS_READ);
  const lines = Array.isArray(out.lines) ? (out.lines as Json[]) : [];
  if (!showCost) {
    delete out.totalCost;
    lines.forEach((l) => {
      delete l.cost;
    });
  }
  if (!showMargin) {
    delete out.totalMargin;
    delete out.marginBps;
    lines.forEach((l) => {
      delete l.margin;
      delete l.marginBps;
    });
  }
  if (!showMargin || !showCost) {
    const findings = Array.isArray(out.findings) ? (out.findings as Json[]) : [];
    findings.forEach((f) => {
      if (f.field === 'margin')
        f.message = 'Margin is below the approval threshold — approval required.';
    });
  }
}

function redactSnapshotInput(input: unknown, role: Role): void {
  if (!input || typeof input !== 'object' || can(role, Permission.COSTS_READ)) return;
  const lines = (input as Json).lines;
  if (Array.isArray(lines))
    (lines as Json[]).forEach((l) => {
      delete l.unitCost;
    });
}

// Money fields arrive as decimal strings and are parsed to bigint minor units.
const money = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/)
  .nullable();
function toMinor(s: string | null): bigint | null {
  if (s === null) return null;
  const [w, fr = ''] = s.split('.');
  return BigInt(w + fr.padEnd(2, '0'));
}

const FeeSchema = z.object({
  amount: money,
  confirmed: z.boolean(),
  taxable: z.boolean().optional(),
});

const QuoteSchema = z.object({
  currency: z.string().length(3),
  lines: z
    .array(
      z.object({
        ref: z.string(),
        productId: z.string(),
        kind: z.string().optional(),
        quantity: z.number().int().positive(),
        unitPrice: money,
        unitCost: money,
        priceSource: z.string().default('price-list'),
        lineDiscountBps: z.number().int().nonnegative().max(10000).optional(),
      }),
    )
    .min(1),
  orderDiscounts: z
    .array(
      z.object({
        amount: money.optional(),
        bps: z.number().int().optional(),
        reason: z.string().min(1),
        authorizedById: z.string().optional(),
        authorizedRole: z.string().optional(),
      }),
    )
    .optional(),
  fees: z
    .object({
      freight: FeeSchema.optional(),
      installation: FeeSchema.optional(),
      travel: FeeSchema.optional(),
      perDiem: FeeSchema.optional(),
      mileage: z
        .object({
          // Fractional miles are fine — the engine multiplies the exact decimal.
          miles: z.number().finite().nonnegative(),
          ratePerMile: money,
          confirmed: z.boolean(),
          taxable: z.boolean().optional(),
        })
        .optional(),
      other: z
        .array(
          z.object({
            label: z.string(),
            amount: money,
            confirmed: z.boolean().optional(),
            taxable: z.boolean().optional(),
          }),
        )
        .optional(),
      creditCardBps: z.number().int().nonnegative().optional(),
    })
    .optional(),
  tax: z
    .object({
      rateBps: z.number().int().nonnegative(),
      exempt: z.boolean(),
      exemptionRef: z.string().optional(),
    })
    .optional(),
  payment: z
    .object({
      depositBps: z.number().int(),
      progressBps: z.number().int(),
      finalBps: z.number().int(),
    })
    .optional(),
  thresholds: z
    .object({
      minMarginBps: z.number().int().optional(),
      discountAuthorityBps: z.number().int().optional(),
    })
    .optional(),
  persist: z.boolean().default(false),
  subjectRef: z.string().optional(),
});

function build(parsed: z.infer<typeof QuoteSchema>): PricingInput {
  return {
    currency: parsed.currency,
    lines: parsed.lines.map((l) => ({
      ...l,
      unitPrice: toMinor(l.unitPrice),
      unitCost: toMinor(l.unitCost),
    })),
    orderDiscounts: parsed.orderDiscounts?.map((d) => ({
      ...d,
      amount: d.amount != null ? (toMinor(d.amount) ?? undefined) : undefined,
    })),
    fees: parsed.fees
      ? {
          freight: parsed.fees.freight
            ? { ...parsed.fees.freight, amount: toMinor(parsed.fees.freight.amount) }
            : undefined,
          installation: parsed.fees.installation
            ? { ...parsed.fees.installation, amount: toMinor(parsed.fees.installation.amount) }
            : undefined,
          travel: parsed.fees.travel
            ? { ...parsed.fees.travel, amount: toMinor(parsed.fees.travel.amount) }
            : undefined,
          perDiem: parsed.fees.perDiem
            ? { ...parsed.fees.perDiem, amount: toMinor(parsed.fees.perDiem.amount) }
            : undefined,
          mileage: parsed.fees.mileage
            ? { ...parsed.fees.mileage, ratePerMile: toMinor(parsed.fees.mileage.ratePerMile) }
            : undefined,
          other: parsed.fees.other?.map((o) => ({ ...o, amount: toMinor(o.amount) })),
          creditCardBps: parsed.fees.creditCardBps,
        }
      : undefined,
    tax: parsed.tax,
    payment: parsed.payment,
    thresholds: effectiveThresholds(parsed.thresholds),
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
    // Persisting writes an immutable snapshot against a deal: that is a write, so it
    // needs a write permission, not just the read that guards the quote itself.
    // Checked before computing so a refused request has no side effects.
    if (parsed.data.persist && !can(req.user!.role, Permission.PROPOSAL_WRITE))
      throw new ForbiddenError(
        `Role ${req.user!.role} lacks permission ${Permission.PROPOSAL_WRITE}`,
      );
    const breakdown = quote(build(parsed.data));

    // Cost & margin are only returned to roles allowed to see them.
    const out = serialize(breakdown) as Json;
    redactBreakdown(out, req.user!.role);

    if (parsed.data.persist) {
      const id = await snapshotQuote(build(parsed.data), breakdown, req.user!.sub, {
        subjectRef: parsed.data.subjectRef,
      });
      (out as Record<string, unknown>).snapshotId = id;
    }
    return out;
  });

  // Manual override — requires pricing:override + a reason (enforced in service).
  app.post(
    '/pricing/override',
    { preHandler: requirePermission(Permission.PRICING_OVERRIDE) },
    async (req, reply) => {
      const body = req.body as {
        subjectRef?: string;
        field?: string;
        previousValue?: string;
        newValue?: string;
        reason?: string;
      };
      if (!body.field || !body.newValue || !body.reason)
        throw new ValidationError('field, newValue and reason are required');
      await logOverride({
        subjectRef: body.subjectRef,
        field: body.field,
        previousValue: body.previousValue,
        newValue: body.newValue,
        reason: body.reason,
        authorizedById: req.user!.sub,
      });
      return reply.status(201).send({ logged: true });
    },
  );

  app.get('/pricing/snapshots/:ref', { preHandler: requireAuth }, async (req) => {
    const { ref } = req.params as { ref: string };
    const role = req.user!.role;
    if (!can(role, Permission.PRICING_READ))
      throw new ForbiddenError(`Role ${role} lacks permission ${Permission.PRICING_READ}`);
    const { prisma } = await import('../lib/prisma.js');
    const rows = serialize(
      await prisma.priceSnapshot.findMany({
        where: { subjectRef: ref },
        orderBy: { createdAt: 'desc' },
      }),
    ) as Json[];
    // The same cost/margin visibility as POST /pricing/quote: a stored snapshot holds
    // the full breakdown and its input (unit costs included).
    for (const row of rows) {
      if (row.breakdown && typeof row.breakdown === 'object')
        redactBreakdown(row.breakdown as Json, role);
      redactSnapshotInput(row.input, role);
    }
    return rows;
  });
}

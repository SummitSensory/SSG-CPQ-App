import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  DEFAULT_HARDWARE_RULES, mergeHardwareRules, evaluateHardwareRules, HARDWARE_INPUTS,
  type HardwareRule,
} from '../proposals/hardwareRules.js';
import { computeAdventureBOM, type AdvAnswers } from '../proposals/adventureSeries.js';

const TermSchema = z.object({ source: z.string().min(3), coefficient: z.number() });
const RuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  terms: z.array(TermSchema).max(40).optional(),
  constant: z.number().optional(),
  factor: z.number().positive().max(10).optional(),
  roundMode: z.enum(['NONE', 'CEIL', 'ROUND']).optional(),
  roundStep: z.number().min(0).max(100).optional(),
  mode: z.enum(['SUM', 'PRESENCE']).optional(),
  minZero: z.boolean().optional(),
  active: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

/** Every source token a term may reference, for the editor's picker. */
async function sources(): Promise<{ frame: string[]; inputs: typeof HARDWARE_INPUTS; hardware: string[] }> {
  const skus = await prisma.sku.findMany({ select: { part: true }, orderBy: { part: 'asc' } });
  const frame = skus.map((s) => s.part).filter((p) => !p.startsWith('6820H-'));
  return { frame, inputs: HARDWARE_INPUTS, hardware: DEFAULT_HARDWARE_RULES.map((r) => r.part) };
}

/** Load the effective rule set: workbook defaults with any database overrides applied. */
export async function loadHardwareRules(): Promise<HardwareRule[]> {
  const rows = await prisma.hardwareRule.findMany({ orderBy: { sortOrder: 'asc' } });
  return mergeHardwareRules(rows as unknown as Partial<HardwareRule>[]);
}

export function registerHardwareRuleRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/hardware-rules', read, async () => {
    const overrides = await prisma.hardwareRule.findMany({ select: { part: true } });
    return {
      rules: await loadHardwareRules(),
      overriddenParts: overrides.map((o) => o.part),
      sources: await sources(),
    };
  });

  /** Edit one part's coefficients. Creates the override row on first edit. */
  app.patch('/hardware-rules/:part', manage, async (req) => {
    const { part } = req.params as { part: string };
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const base = DEFAULT_HARDWARE_RULES.find((r) => r.part === part);
    const existing = await prisma.hardwareRule.findUnique({ where: { part } });
    if (!base && !existing && !parsed.data.terms) throw new ValidationError('Unknown part — send terms to define a new rule.');
    const start = existing
      ? (existing as unknown as HardwareRule)
      : base ?? ({ part, name: part, terms: [], constant: 0, factor: 1, roundMode: 'NONE', roundStep: 1, mode: 'SUM', minZero: true, sortOrder: 999, active: true } as HardwareRule);
    const next = { ...start, ...parsed.data };
    const data = {
      name: next.name, terms: next.terms as object, constant: next.constant, factor: next.factor,
      roundMode: next.roundMode, roundStep: next.roundStep, mode: next.mode, minZero: next.minZero,
      sortOrder: base?.sortOrder ?? next.sortOrder ?? 999, active: next.active, note: next.note ?? null,
      updatedById: req.user!.sub,
    };
    const saved = await prisma.hardwareRule.upsert({ where: { part }, create: { part, ...data }, update: data });
    await recordAudit({ actorId: req.user!.sub, action: 'hardware.rule.update', entity: 'HardwareRule', entityId: saved.id, details: parsed.data as object });
    return saved;
  });

  /** Drop one part's override, returning it to the workbook default. */
  app.delete('/hardware-rules/:part', manage, async (req, reply) => {
    const { part } = req.params as { part: string };
    await prisma.hardwareRule.deleteMany({ where: { part } });
    await recordAudit({ actorId: req.user!.sub, action: 'hardware.rule.reset', entity: 'HardwareRule', entityId: part });
    reply.code(204);
    return null;
  });

  /** Clear every override — the whole set returns to the v73 workbook values. */
  app.post('/hardware-rules/reset', manage, async (req) => {
    const { count } = await prisma.hardwareRule.deleteMany({});
    await recordAudit({ actorId: req.user!.sub, action: 'hardware.rule.reset-all', details: { cleared: count } });
    return { cleared: count, rules: DEFAULT_HARDWARE_RULES };
  });

  /**
   * Dry-run: evaluate the saved rules — or a proposed edit that has not been saved
   * — against a configuration, so a coefficient change can be checked before it
   * touches live proposals.
   */
  app.post('/hardware-rules/preview', read, async (req) => {
    const body = (req.body || {}) as { answers?: AdvAnswers; overrides?: (Partial<HardwareRule> & { part: string })[] };
    const answers = (body.answers || {}) as AdvAnswers;
    const saved = await loadHardwareRules();
    const proposed = body.overrides?.length
      ? saved.map((r) => {
        const o = body.overrides!.find((x) => x.part === r.part);
        return o ? ({ ...r, ...o, terms: (o.terms as HardwareRule['terms']) ?? r.terms } as HardwareRule) : r;
      })
      : saved;
    const bom = computeAdventureBOM(answers);
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const inputs: Record<string, number> = {
      bracketsQty: num(answers.bracketsQty), swivel360: num(answers.swivel360),
      swivelStandalone: num(answers.swivelStandalone), forged: num(answers.forged),
      swingHanger: num(answers.swingHanger), vRings: num(answers.vRings),
    };
    const ctx = {
      bom: (part: string) => (bom.find((b) => b.part === part) || { qty: 0 }).qty,
      input: (key: string) => inputs[key] ?? 0,
    };
    const before = evaluateHardwareRules(saved, ctx);
    const after = evaluateHardwareRules(proposed, ctx);
    const parts = [...new Set([...before, ...after].map((r) => r.part))];
    return {
      frame: bom,
      rows: parts.map((p) => {
        const b = before.find((r) => r.part === p), a2 = after.find((r) => r.part === p);
        return {
          part: p,
          name: (a2 || b)!.name,
          formula: (a2 || b)!.formula,
          qtyBefore: b?.qty ?? 0,
          qtyAfter: a2?.qty ?? 0,
          changed: (b?.qty ?? 0) !== (a2?.qty ?? 0),
        };
      }),
    };
  });
}

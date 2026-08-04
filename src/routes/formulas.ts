import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  DEFAULT_HARDWARE_RULES, HARDWARE_INPUTS, mergeRules, evaluateRules,
  type FormulaRule,
} from '../proposals/hardwareRules.js';
import { DEFAULT_FRAME_RULES, FRAME_INPUTS, FRAME_SHAPES, frameContext } from '../proposals/frameRules.js';
import { FORMULA_SETTINGS, mergeSettings, defaultSettings, type FormulaSettings } from '../proposals/formulaSettings.js';
import { computeAdventureBOM, type AdvAnswers } from '../proposals/adventureSeries.js';

/**
 * Every formula in the pricing engine, in one place.
 *
 * Two rule sets share the same shape and editor — frame/component quantities and
 * hardware fastener quantities — plus the business scalars (deposit %, proposal
 * validity, leg spans). The handful of genuinely structural calculations are
 * reported as read-only entries so the page is a complete inventory rather than a
 * partial one.
 */

const KINDS = ['FRAME', 'HARDWARE'] as const;
type Kind = (typeof KINDS)[number];

const ConditionSchema = z.object({
  input: z.string().min(1),
  op: z.enum(['=', '!=', '>', '<', '>=', '<=']),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const TermSchema = z.object({
  source: z.string().min(3).optional(),
  coefficient: z.number(),
  when: ConditionSchema.optional(),
});
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
  when: ConditionSchema.nullable().optional(),
  group: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const defaultsFor = (kind: Kind): FormulaRule[] => (kind === 'FRAME' ? DEFAULT_FRAME_RULES : DEFAULT_HARDWARE_RULES);

/** Calculations that are a lookup or a code path, not an editable coefficient. */
const IN_CODE = [
  {
    name: 'Beam member calculator',
    where: 'src/proposals/adventureSeries.ts → beamMembers()',
    what: 'Chooses short-cap members by frame WIDTH and long members by LENGTH from the workbook lookup table (5′–10′ parts), adds the 6-leg / 8-leg members and interior beams, and applies the monkey-bar half-offset.',
    why: 'A per-length lookup with offsets rather than a multiplier — changing it means changing which part numbers apply, not a number.',
  },
  {
    name: 'Trolley rail sizing',
    where: 'src/proposals/adventureSeries.ts → trolleyRail()',
    what: 'Picks the TR2000-A07…A10 rail from frame length − 1, quantity 2.',
    why: 'Chooses a part number from a size table.',
  },
  {
    name: 'Frame configuration product number',
    where: 'src/proposals/adventureSeries.ts → frameModelNumber()',
    what: 'Builds e.g. SQ-2MBL2TZR from shape, interior beams, monkey bars, ladders, trolley, zip line and ball rack.',
    why: 'A naming convention, not a quantity.',
  },
  {
    name: 'Proposal totals',
    where: 'public/app.js → builderTotals() and src/proposals/analytics.ts → versionTotals()',
    what: 'subtotal − discount + third-party freight + tax + structure freight + mats freight; margin = revenue − COGS.',
    why: 'The order of operations is fixed; the editable parts (deposit %, discount, freight, tax) are entered per proposal or set under Business numbers.',
  },
  {
    name: 'H-1000 roll-up',
    where: 'src/proposals/adventureSeries.ts → hardwareRollup()',
    what: 'Sums every fastener’s price, cost and weight into the single H-1000 line. Whether the fasteners are also listed in that line’s description is set by “List every fastener on the Hardware Kit line” under Business numbers — it changes the wording only, never the total.',
    why: 'A sum of the hardware rules above — edit those to change it.',
  },
];

export async function loadFormulaRules(): Promise<{ frame: FormulaRule[]; hardware: FormulaRule[] }> {
  const rows = await prisma.hardwareRule.findMany({ orderBy: { sortOrder: 'asc' } });
  const byKind = (kind: Kind) => rows.filter((r) => (r as unknown as { kind?: string }).kind === kind || (kind === 'HARDWARE' && !(r as unknown as { kind?: string }).kind));
  return {
    frame: mergeRules(DEFAULT_FRAME_RULES, byKind('FRAME') as unknown as Partial<FormulaRule>[]),
    hardware: mergeRules(DEFAULT_HARDWARE_RULES, byKind('HARDWARE') as unknown as Partial<FormulaRule>[]),
  };
}

export async function loadFormulaSettings(): Promise<FormulaSettings> {
  const rows = await prisma.formulaSetting.findMany();
  return mergeSettings(rows.map((r) => ({ key: r.key, value: Number(r.value) })));
}

export function registerFormulaRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  const parseKind = (v: string): Kind => {
    const k = v.toUpperCase() as Kind;
    if (!KINDS.includes(k)) throw new ValidationError('Unknown formula set');
    return k;
  };

  app.get('/formulas', read, async () => {
    const [rules, settings, overrides, skus] = await Promise.all([
      loadFormulaRules(),
      loadFormulaSettings(),
      prisma.hardwareRule.findMany({ select: { part: true, kind: true } }),
      prisma.sku.findMany({ select: { part: true }, orderBy: { part: 'asc' } }),
    ]);
    const overriddenBy = (kind: Kind) => overrides.filter((o) => (o.kind || 'HARDWARE') === kind).map((o) => o.part);
    const frameParts = DEFAULT_FRAME_RULES.map((r) => r.part);
    return {
      frame: {
        label: 'Frame & component quantities',
        blurb: 'How many of each frame part a configuration produces.',
        rules: rules.frame,
        overriddenParts: overriddenBy('FRAME'),
        inputs: FRAME_INPUTS,
        shapes: FRAME_SHAPES,
      },
      hardware: {
        label: 'Hardware fastener quantities',
        blurb: 'The 37 fasteners that roll up into the single H-1000 line.',
        rules: rules.hardware,
        overriddenParts: overriddenBy('HARDWARE'),
        inputs: HARDWARE_INPUTS.map((i) => ({ ...i, kind: 'number' as const })),
      },
      settings: { values: settings, defs: FORMULA_SETTINGS, defaults: defaultSettings() },
      sources: {
        frameParts,
        hardwareParts: DEFAULT_HARDWARE_RULES.map((r) => r.part),
        skuParts: skus.map((s) => s.part),
      },
      inCode: IN_CODE,
    };
  });

  app.patch('/formulas/:kind/:part', manage, async (req) => {
    const { kind: kindRaw, part } = req.params as { kind: string; part: string };
    const kind = parseKind(kindRaw);
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const base = defaultsFor(kind).find((r) => r.part === part);
    const existing = await prisma.hardwareRule.findFirst({ where: { part, kind } });
    if (!base && !existing && !parsed.data.terms) throw new ValidationError('Unknown part — send terms to define a new rule.');
    const start = (existing as unknown as FormulaRule) ?? base ?? ({
      part, name: part, terms: [], constant: 0, factor: 1, roundMode: 'NONE', roundStep: 1,
      mode: 'SUM', minZero: true, sortOrder: 999, active: true,
    } as FormulaRule);
    const next = { ...start, ...parsed.data };
    const data = {
      kind, name: next.name, terms: next.terms as object, constant: next.constant, factor: next.factor,
      roundMode: next.roundMode, roundStep: next.roundStep, mode: next.mode, minZero: next.minZero,
      sortOrder: base?.sortOrder ?? next.sortOrder ?? 999, active: next.active,
      group: base?.group ?? parsed.data.group ?? next.group ?? null,
      // Prisma rejects a bare `null` on a nullable Json column — it wants the field
      // omitted (leave as-is) or Prisma.DbNull (clear it). RuleCondition is a plain
      // interface with no index signature, so it needs the double cast.
      when: (parsed.data.when === null
        ? Prisma.DbNull
        : ((next.when ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue)),
      note: next.note ?? null,
      updatedById: req.user!.sub,
    };
    const saved = existing
      ? await prisma.hardwareRule.update({ where: { id: existing.id }, data })
      : await prisma.hardwareRule.create({ data: { part, ...data } });
    await recordAudit({ actorId: req.user!.sub, action: 'formula.rule.update', entity: 'HardwareRule', entityId: saved.id, details: { kind, part, ...parsed.data } as Record<string, unknown> });
    return saved;
  });

  /** Revert one rule to its workbook default. */
  app.delete('/formulas/:kind/:part', manage, async (req, reply) => {
    const { kind: kindRaw, part } = req.params as { kind: string; part: string };
    const kind = parseKind(kindRaw);
    await prisma.hardwareRule.deleteMany({ where: { part, kind } });
    await recordAudit({ actorId: req.user!.sub, action: 'formula.rule.reset', entity: 'HardwareRule', entityId: `${kind}:${part}` });
    reply.code(204);
    return null;
  });

  /** Clear every override in one set (or all sets when no kind is given). */
  app.post('/formulas/reset', manage, async (req) => {
    const body = (req.body || {}) as { kind?: string; settings?: boolean };
    const where = body.kind ? { kind: parseKind(body.kind) } : {};
    const { count } = await prisma.hardwareRule.deleteMany({ where });
    let settingsCleared = 0;
    if (body.settings !== false && !body.kind) settingsCleared = (await prisma.formulaSetting.deleteMany({})).count;
    await recordAudit({ actorId: req.user!.sub, action: 'formula.reset', details: { kind: body.kind ?? 'ALL', cleared: count, settingsCleared } });
    return { cleared: count, settingsCleared };
  });

  /** Just the business numbers — read by the browser at sign-in. */
  app.get('/formulas/settings', read, async () => loadFormulaSettings());

  app.patch('/formulas/settings', manage, async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const updates: { key: string; value: number }[] = [];
    for (const def of FORMULA_SETTINGS) {
      const raw = body[def.key];
      if (raw === undefined) continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new ValidationError(`${def.label} must be a number`);
      if (v < def.min || v > def.max) throw new ValidationError(`${def.label} must be between ${def.min} and ${def.max} ${def.unit}`);
      updates.push({ key: def.key, value: v });
    }
    if (!updates.length) throw new ValidationError('Nothing to update');
    for (const u of updates) {
      await prisma.formulaSetting.upsert({
        where: { key: u.key },
        create: { key: u.key, value: u.value, updatedById: req.user!.sub },
        update: { value: u.value, updatedById: req.user!.sub },
      });
    }
    await recordAudit({ actorId: req.user!.sub, action: 'formula.settings.update', details: Object.fromEntries(updates.map((u) => [u.key, u.value])) });
    return loadFormulaSettings();
  });

  /**
   * Dry-run a pending edit against a configuration: quantities before → after,
   * including any knock-on change to dependent rows.
   */
  app.post('/formulas/preview', read, async (req) => {
    const body = (req.body || {}) as {
      kind?: string;
      answers?: AdvAnswers;
      overrides?: (Partial<FormulaRule> & { part: string })[];
    };
    const kind = parseKind(body.kind ?? 'HARDWARE');
    const answers = (body.answers || {}) as AdvAnswers;
    const saved = await loadFormulaRules();
    const base = kind === 'FRAME' ? saved.frame : saved.hardware;
    const proposed = body.overrides?.length
      ? base.map((r) => {
        const o = body.overrides!.find((x) => x.part === r.part);
        return o ? ({ ...r, ...o, terms: (o.terms as FormulaRule['terms']) ?? r.terms } as FormulaRule) : r;
      })
      : base;

    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
    const evalSet = (rules: FormulaRule[]) => {
      if (kind === 'FRAME') return evaluateRules(rules, frameContext(answers, () => 0));
      const bom = computeAdventureBOM(answers, saved.frame);
      const inputs: Record<string, number> = {
        bracketsQty: num(answers.bracketsQty), swivel360: num(answers.swivel360),
        swivelStandalone: num(answers.swivelStandalone), forged: num(answers.forged),
        swingHanger: num(answers.swingHanger), vRings: num(answers.vRings),
      };
      return evaluateRules(rules, {
        // Summed across every BOM row for that part — a multi-span frame emits one
        // row per span, so first-match under-counted the beams hardware hangs off.
        bom: (part: string) => bom.reduce((s, b) => (b.part === part ? s + b.qty : s), 0),
        input: (key: string) => inputs[key] ?? 0,
      });
    };

    const before = evalSet(base);
    const after = evalSet(proposed);
    const parts = [...new Set([...before, ...after].map((r) => r.part))];
    return {
      kind,
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

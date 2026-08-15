import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  DEFAULT_HARDWARE_RULES,
  HARDWARE_INPUTS,
  mergeRules,
  evaluateRules,
  type FormulaRule,
} from '../proposals/hardwareRules.js';
import {
  DEFAULT_FRAME_RULES,
  FRAME_INPUTS,
  FRAME_SHAPES,
  frameContext,
} from '../proposals/frameRules.js';
import {
  FORMULA_SETTINGS,
  mergeSettings,
  defaultSettings,
  type FormulaSettings,
} from '../proposals/formulaSettings.js';
import { computeAdventureBOM, type AdvAnswers } from '../proposals/adventureSeries.js';
import {
  CONFIRM_WORD,
  assertConfirmed,
  impactedOrders,
  impactSentence,
  writeRevisions,
  listRevisions,
  revisionDetail,
  undoRevision,
  describeRuleChange,
  describeSettingChange,
  type RevisionInput,
  type RevisionKind,
  type RuleSnapshot,
} from '../proposals/formulaRevisions.js';

/**
 * Every formula in the pricing engine, in one place.
 *
 * Two rule sets share the same shape and editor — frame/component quantities and
 * hardware fastener quantities — plus the business scalars (deposit %, proposal
 * validity, leg spans). The handful of genuinely structural calculations are
 * reported as read-only entries so the page is a complete inventory rather than a
 * partial one.
 *
 * ---------------------------------------------------------------------------
 * Confirmation gate
 *
 * Every write in this file now demands the word CONFIRMED. That covers editing a
 * rule, adding one, resetting one, restoring the workbook defaults, and changing a
 * business number — the five surfaces that can move a price or a quantity.
 *
 * This REPLACES the narrower gate that previously applied only to the mat-pricing
 * business numbers and accepted the word CONFIRM. One word across the whole page
 * is easier to trust than two words with a rule about which applies where; the
 * check is case-insensitive and trimmed, because the gate exists to force a pause,
 * not to catch typists out.
 *
 * The gate is enforced HERE, not only in the browser, so a direct API call is held
 * to the same standard.
 * ---------------------------------------------------------------------------
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
  /** The typed confirmation. Checked by assertConfirmed, not by zod. */
  confirm: z.string().optional(),
});

const defaultsFor = (kind: Kind): FormulaRule[] =>
  kind === 'FRAME' ? DEFAULT_FRAME_RULES : DEFAULT_HARDWARE_RULES;

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
    name: 'Adventure floor mat sizing and part number',
    where: 'src/proposals/matPricing.ts → computeFloorPadding()',
    what: 'Adds the mat overage to each side of the frame footprint, converts to square feet, multiplies by the cost per square foot for the chosen thickness, then applies the mat markup. The part number R-SSG-{LLWW}CLM[-2] is built from the same dimensions.',
    why: 'The four numbers behind it — cost per sq ft at each thickness, the markup and the overage — ARE editable, under Business numbers → Mat pricing. What stays in code is the shape of the calculation and the part-number convention, which no proposal can be allowed to disagree with retroactively.',
  },
  {
    name: 'H-1000 roll-up',
    where: 'src/proposals/adventureSeries.ts → hardwareRollup()',
    what: 'Sums every fastener’s price, cost and weight into the single H-1000 line. Whether the fasteners are also listed in that line’s description is set by “List every fastener on the Hardware Kit line” under Business numbers — it changes the wording only, never the total.',
    why: 'A sum of the hardware rules above — edit those to change it.',
  },
];

export async function loadFormulaRules(): Promise<{
  frame: FormulaRule[];
  hardware: FormulaRule[];
}> {
  const rows = await prisma.hardwareRule.findMany({ orderBy: { sortOrder: 'asc' } });
  const byKind = (kind: Kind) =>
    rows.filter(
      (r) =>
        (r as unknown as { kind?: string }).kind === kind ||
        (kind === 'HARDWARE' && !(r as unknown as { kind?: string }).kind),
    );
  return {
    frame: mergeRules(DEFAULT_FRAME_RULES, byKind('FRAME') as unknown as Partial<FormulaRule>[]),
    hardware: mergeRules(
      DEFAULT_HARDWARE_RULES,
      byKind('HARDWARE') as unknown as Partial<FormulaRule>[],
    ),
  };
}

export async function loadFormulaSettings(): Promise<FormulaSettings> {
  const rows = await prisma.formulaSetting.findMany();
  return mergeSettings(rows.map((r) => ({ key: r.key, value: Number(r.value) })));
}

/**
 * Reduce a stored rule (or a workbook default) to the fields that define it.
 *
 * Only these fields go into a revision snapshot. Ids, timestamps and updatedById
 * are deliberately left out: a snapshot is the RULE, and including bookkeeping
 * columns would make every save look like a change to the diff that composes the
 * log summary.
 */
function snapshot(r: Record<string, unknown> | null | undefined): RuleSnapshot | null {
  if (!r) return null;
  return {
    part: String(r.part ?? ''),
    name: (r.name ?? null) as string | null,
    terms: r.terms ?? [],
    constant: Number(r.constant ?? 0),
    factor: Number(r.factor ?? 1),
    roundMode: String(r.roundMode ?? 'NONE'),
    roundStep: Number(r.roundStep ?? 1),
    mode: String(r.mode ?? 'SUM'),
    minZero: r.minZero !== false,
    active: r.active !== false,
    when: r.when ?? null,
    group: (r.group ?? null) as string | null,
    note: (r.note ?? null) as string | null,
  };
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
    const overriddenBy = (kind: Kind) =>
      overrides.filter((o) => (o.kind || 'HARDWARE') === kind).map((o) => o.part);
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
      /** So the editor asks for the same word the server enforces. */
      confirmWord: CONFIRM_WORD,
    };
  });

  /**
   * Which open orders were built on the current figures — read BEFORE confirming,
   * so the warning in the editor is the same list that will be recorded and
   * emailed. `part` may be repeated; omit it entirely for a business number, whose
   * reach is every open order.
   */
  app.get('/formulas/impact', read, async (req) => {
    const q = req.query as { part?: string | string[] };
    const parts = q.part == null ? [] : Array.isArray(q.part) ? q.part : [q.part];
    const orders = await impactedOrders(parts);
    return { orders, count: orders.length, sentence: impactSentence(orders.length) };
  });

  app.patch('/formulas/:kind/:part', manage, async (req) => {
    const { kind: kindRaw, part } = req.params as { kind: string; part: string };
    const kind = parseKind(kindRaw);
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { confirm, ...patch } = parsed.data;

    const base = defaultsFor(kind).find((r) => r.part === part);
    const existing = await prisma.hardwareRule.findFirst({ where: { part, kind } });
    if (!base && !existing && !patch.terms)
      throw new ValidationError('Unknown part — send terms to define a new rule.');

    const confirmedWord = assertConfirmed(
      confirm,
      `change ${part}${base?.name ? ` (${base.name})` : ''}`,
    );

    const start =
      (existing as unknown as FormulaRule) ??
      base ??
      ({
        part,
        name: part,
        terms: [],
        constant: 0,
        factor: 1,
        roundMode: 'NONE',
        roundStep: 1,
        mode: 'SUM',
        minZero: true,
        sortOrder: 999,
        active: true,
      } as FormulaRule);
    const next = { ...start, ...patch };
    const data = {
      kind,
      name: next.name,
      terms: next.terms as object,
      constant: next.constant,
      factor: next.factor,
      roundMode: next.roundMode,
      roundStep: next.roundStep,
      mode: next.mode,
      minZero: next.minZero,
      sortOrder: base?.sortOrder ?? next.sortOrder ?? 999,
      active: next.active,
      group: base?.group ?? patch.group ?? next.group ?? null,
      // Prisma rejects a bare `null` on a nullable Json column — it wants the field
      // omitted (leave as-is) or Prisma.DbNull (clear it). RuleCondition is a plain
      // interface with no index signature, so it needs the double cast.
      when:
        patch.when === null
          ? Prisma.DbNull
          : ((next.when ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue),
      note: next.note ?? null,
      updatedById: req.user!.sub,
    };

    // Captured before the write. `before` is null when no override existed, which
    // is what makes an undo of a first-time edit a reset rather than a restore.
    const beforeSnap = snapshot(existing as unknown as Record<string, unknown>);

    const saved = existing
      ? await prisma.hardwareRule.update({ where: { id: existing.id }, data })
      : await prisma.hardwareRule.create({ data: { part, ...data } });

    const afterSnap = snapshot(saved as unknown as Record<string, unknown>);
    const displayName = String(next.name ?? base?.name ?? part);

    const revision = await writeRevisions({
      actorId: req.user!.sub,
      confirmedWord,
      parts: [part],
      entries: [
        {
          kind: kind as RevisionKind,
          action: existing ? 'UPDATE' : 'CREATE',
          target: part,
          targetName: displayName,
          before: beforeSnap,
          after: afterSnap,
          summary: describeRuleChange(part, displayName, beforeSnap, afterSnap),
        },
      ],
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'formula.rule.update',
      entity: 'HardwareRule',
      entityId: saved.id,
      details: { kind, part, ...patch, revisionBatchId: revision.batchId } as Record<
        string,
        unknown
      >,
    });

    return {
      ...saved,
      revision: {
        batchId: revision.batchId,
        impactedCount: revision.impacted.length,
        impactedOrders: revision.impacted,
        notifyError: revision.notifyError,
      },
    };
  });

  /** Revert one rule to its workbook default. */
  app.delete('/formulas/:kind/:part', manage, async (req) => {
    const { kind: kindRaw, part } = req.params as { kind: string; part: string };
    const kind = parseKind(kindRaw);
    // DELETE carries no body in most clients, so the confirmation rides on the
    // query string. Same word, same check.
    const q = req.query as { confirm?: string };
    const base = defaultsFor(kind).find((r) => r.part === part);
    const confirmedWord = assertConfirmed(q.confirm, `reset ${part} to its workbook default`);

    const existing = await prisma.hardwareRule.findFirst({ where: { part, kind } });
    if (!existing)
      throw new ValidationError(`${part} has no override — it is already on the workbook default.`);

    const beforeSnap = snapshot(existing as unknown as Record<string, unknown>);
    await prisma.hardwareRule.deleteMany({ where: { part, kind } });

    const displayName = String(existing.name ?? base?.name ?? part);
    const revision = await writeRevisions({
      actorId: req.user!.sub,
      confirmedWord,
      parts: [part],
      entries: [
        {
          kind: kind as RevisionKind,
          action: 'RESET',
          target: part,
          targetName: displayName,
          before: beforeSnap,
          after: null,
          summary: describeRuleChange(part, displayName, beforeSnap, null),
        },
      ],
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'formula.rule.reset',
      entity: 'HardwareRule',
      entityId: `${kind}:${part}`,
      details: { revisionBatchId: revision.batchId },
    });

    return {
      reset: part,
      revision: {
        batchId: revision.batchId,
        impactedCount: revision.impacted.length,
        impactedOrders: revision.impacted,
        notifyError: revision.notifyError,
      },
    };
  });

  /** Clear every override in one set (or all sets when no kind is given). */
  app.post('/formulas/reset', manage, async (req) => {
    const body = (req.body || {}) as { kind?: string; settings?: boolean; confirm?: string };
    const kind = body.kind ? parseKind(body.kind) : null;
    const confirmedWord = assertConfirmed(
      body.confirm,
      kind
        ? `restore the workbook defaults for ${kind === 'FRAME' ? 'Frame & components' : 'Hardware fasteners'}`
        : 'restore every workbook default',
    );

    const where = kind ? { kind } : {};
    // Read the rows before deleting them: one revision per cleared override is
    // what makes each of them individually undoable afterwards.
    const doomed = await prisma.hardwareRule.findMany({ where });
    const clearSettings = body.settings !== false && !kind;
    const settingRows = clearSettings ? await prisma.formulaSetting.findMany() : [];

    const { count } = await prisma.hardwareRule.deleteMany({ where });
    let settingsCleared = 0;
    if (clearSettings) settingsCleared = (await prisma.formulaSetting.deleteMany({})).count;

    const entries: RevisionInput[] = doomed.map((r) => {
      const snap = snapshot(r as unknown as Record<string, unknown>);
      const nm = String(r.name ?? r.part);
      return {
        kind: ((r as unknown as { kind?: string }).kind ?? 'HARDWARE') as RevisionKind,
        action: 'RESET_ALL',
        target: r.part,
        targetName: nm,
        before: snap,
        after: null,
        summary: describeRuleChange(r.part, nm, snap, null),
      };
    });
    for (const s of settingRows) {
      entries.push({
        kind: 'SETTING',
        action: 'RESET_ALL',
        target: s.key,
        targetName: FORMULA_SETTINGS.find((d) => d.key === s.key)?.label ?? s.key,
        before: { key: s.key, value: Number(s.value) },
        after: null,
        summary: describeSettingChange(s.key, Number(s.value), null),
      });
    }

    const revision = entries.length
      ? await writeRevisions({
          actorId: req.user!.sub,
          confirmedWord,
          // A blanket restore reaches everything, so the impact list is every open
          // order rather than the union of the parts cleared.
          parts: [],
          entries,
        })
      : { batchId: '', impacted: [], notifyError: null, ids: [] };

    await recordAudit({
      actorId: req.user!.sub,
      action: 'formula.reset',
      details: {
        kind: body.kind ?? 'ALL',
        cleared: count,
        settingsCleared,
        revisionBatchId: revision.batchId,
      },
    });

    return {
      cleared: count,
      settingsCleared,
      revision: {
        batchId: revision.batchId,
        impactedCount: revision.impacted.length,
        impactedOrders: revision.impacted,
        notifyError: revision.notifyError,
      },
    };
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
      if (v < def.min || v > def.max)
        throw new ValidationError(
          `${def.label} must be between ${def.min} and ${def.max} ${def.unit}`,
        );
      updates.push({ key: def.key, value: v });
    }
    if (!updates.length) throw new ValidationError('Nothing to update');

    /**
     * Only keys whose value actually MOVES count as a change: saving the panel
     * untouched is not an edit, demands no confirmation, and writes no revision.
     * Previously this test guarded the mat-pricing keys alone; it now governs every
     * business number, which is why the word is CONFIRMED rather than CONFIRM.
     */
    const existingRows = await prisma.formulaSetting.findMany();
    const hadRow = new Map(existingRows.map((r) => [r.key, Number(r.value)]));
    const current = await loadFormulaSettings();
    const moved = updates.filter((u) => Number(current[u.key]) !== u.value);

    if (!moved.length) return loadFormulaSettings();

    const names = moved
      .map((g) => FORMULA_SETTINGS.find((d) => d.key === g.key)?.label ?? g.key)
      .join(', ');
    const confirmedWord = assertConfirmed(body.confirm, `change ${names}`);

    for (const u of moved) {
      await prisma.formulaSetting.upsert({
        where: { key: u.key },
        create: { key: u.key, value: u.value, updatedById: req.user!.sub },
        update: { value: u.value, updatedById: req.user!.sub },
      });
    }

    const revision = await writeRevisions({
      actorId: req.user!.sub,
      confirmedWord,
      // A business number is not part-specific, so every open order is in scope.
      parts: [],
      entries: moved.map((u) => {
        // `before` is null only when no override row existed, so an undo of a
        // first-time change removes the row rather than writing the default back
        // into it — the two are different states.
        const prior = hadRow.has(u.key) ? hadRow.get(u.key)! : null;
        return {
          kind: 'SETTING' as RevisionKind,
          action: prior == null ? 'CREATE' : 'UPDATE',
          target: u.key,
          targetName: FORMULA_SETTINGS.find((d) => d.key === u.key)?.label ?? u.key,
          before: prior == null ? null : { key: u.key, value: prior },
          after: { key: u.key, value: u.value },
          summary: describeSettingChange(u.key, prior ?? Number(current[u.key]), u.value),
        };
      }),
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'formula.settings.update',
      details: {
        ...Object.fromEntries(moved.map((u) => [u.key, u.value])),
        confirmed: moved.map((g) => ({
          key: g.key,
          from: Number(current[g.key]),
          to: g.value,
        })),
        revisionBatchId: revision.batchId,
      } as Record<string, unknown>,
    });

    const values = await loadFormulaSettings();
    return {
      ...values,
      revision: {
        batchId: revision.batchId,
        impactedCount: revision.impacted.length,
        impactedOrders: revision.impacted,
        notifyError: revision.notifyError,
      },
    };
  });

  // ---------------- Revision log ----------------

  /**
   * The log. `kind` scopes it to one tab's panel; omit it for the combined log.
   * Readable by anyone who can read proposals — knowing a coefficient moved is not
   * privileged, and the people who need it most are the ones chasing a wrong BOM.
   */
  app.get('/formulas/revisions', read, async (req) => {
    const q = req.query as { kind?: string; limit?: string };
    const kind = q.kind ? (q.kind.toUpperCase() as RevisionKind) : undefined;
    if (kind && !['FRAME', 'HARDWARE', 'SETTING'].includes(kind))
      throw new ValidationError('Unknown formula set');
    return listRevisions({ kind, limit: q.limit ? Number(q.limit) : undefined });
  });

  app.get('/formulas/revisions/:id', read, async (req) =>
    revisionDetail((req.params as { id: string }).id),
  );

  /**
   * Undo one revision. System administrators only — this is the one action that
   * changes a formula without going through the editor, so it is held tighter than
   * the edit it reverses.
   */
  app.post('/formulas/revisions/:id/undo', manage, async (req) => {
    if (req.user!.role !== 'SYSTEM_ADMIN')
      throw new ForbiddenError('Only a system administrator can undo a formula change');
    const { id } = req.params as { id: string };
    const result = await undoRevision(id, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'formula.revision.undo',
      entity: 'FormulaRevision',
      entityId: id,
      details: { revisionBatchId: result.batchId },
    });
    return {
      undone: id,
      revision: {
        batchId: result.batchId,
        impactedCount: result.impacted.length,
        impactedOrders: result.impacted,
        notifyError: result.notifyError,
      },
    };
  });

  /**
   * Every vendor part-number mapping, for the Formulas page's own list.
   *
   * The mapping is maintained per vendor under Catalog → Manufacturers, and the
   * writes still live there. This is the read the other door needs: the mat numbers
   * it maps are generated by the pricing engine, so the person looking at the
   * formulas is often the person who needs the mapping.
   */
  app.get('/formulas/vendor-parts', read, async () => {
    const rows = await prisma.vendorPartNumber.findMany({
      orderBy: [{ manufacturerId: 'asc' }, { ourPart: 'asc' }],
      include: { manufacturer: { select: { name: true } } },
    });
    return {
      rows: rows.map((r) => ({
        id: r.id,
        manufacturerId: r.manufacturerId,
        vendor: r.manufacturer.name,
        ourPart: r.ourPart,
        vendorPart: r.vendorPart,
        description: r.description,
        active: r.active,
      })),
    };
  });

  // ---------------- Paint colour chart ----------------
  //
  // Goldberg Brothers powder coat our steel, and the customer does not choose one
  // colour for the whole structure: they choose one per GROUP of parts. Which group
  // a part belongs to is a property of the part, so the chart is maintained here
  // once and every Bill of Materials reads it — the BOM then asks for a brand and a
  // code per group and paints only the parts in that group.
  //
  // Groups are seeded A–E by the migration and can be renamed; the letter is a
  // label, not an identifier.

  const GroupInput = z.object({
    name: z.string().trim().min(1).max(40),
    label: z.string().trim().max(120).nullish(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  });

  app.get('/formulas/paint-colors', read, async () => {
    const groups = await prisma.paintColorGroup.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { skus: { orderBy: { sku: 'asc' } } },
    });
    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        label: g.label,
        sortOrder: g.sortOrder,
        skus: g.skus.map((s) => ({ id: s.id, sku: s.sku })),
      })),
      /** Every part the chart could cover, so the editor can offer a picker. */
      skuParts: (
        await prisma.sku.findMany({ select: { part: true }, orderBy: { part: 'asc' } })
      ).map((s) => s.part),
    };
  });

  app.post('/formulas/paint-colors/groups', manage, async (req, reply) => {
    const parsed = GroupInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid group');
    const d = parsed.data;
    const dupe = await prisma.paintColorGroup.findFirst({
      where: { name: { equals: d.name, mode: 'insensitive' } },
    });
    if (dupe) throw new ValidationError(`There is already a group called ${d.name}.`);
    const last = await prisma.paintColorGroup.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const g = await prisma.paintColorGroup.create({
      data: {
        name: d.name,
        label: d.label || null,
        sortOrder: d.sortOrder ?? (last?.sortOrder ?? 0) + 10,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paintColor.group.create',
      entity: 'PaintColorGroup',
      entityId: g.id,
      details: { name: g.name },
    });
    return reply.status(201).send(g);
  });

  app.patch('/formulas/paint-colors/groups/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = GroupInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid group');
    const existing = await prisma.paintColorGroup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('That paint colour group no longer exists');
    const d = parsed.data;
    if (d.name && d.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupe = await prisma.paintColorGroup.findFirst({
        where: { name: { equals: d.name, mode: 'insensitive' }, id: { not: id } },
      });
      if (dupe) throw new ValidationError(`There is already a group called ${d.name}.`);
    }
    const g = await prisma.paintColorGroup.update({
      where: { id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.label !== undefined ? { label: d.label || null } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paintColor.group.update',
      entity: 'PaintColorGroup',
      entityId: id,
      details: d as Record<string, unknown>,
    });
    return g;
  });

  /** Removing a group ungroups its parts rather than deleting them silently. */
  app.delete('/formulas/paint-colors/groups/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.paintColorGroup.findUnique({
      where: { id },
      include: { _count: { select: { skus: true } } },
    });
    if (!existing) throw new NotFoundError('That paint colour group no longer exists');
    const q = req.query as { force?: string };
    if (existing._count.skus && q.force !== 'true') {
      throw new ValidationError(
        `${existing.name} has ${existing._count.skus} part${existing._count.skus === 1 ? '' : 's'} in it. ` +
          'Move them to another group first, or confirm removing the group and ungrouping them.',
      );
    }
    await prisma.paintColorGroup.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paintColor.group.delete',
      entity: 'PaintColorGroup',
      entityId: id,
      details: { name: existing.name, ungrouped: existing._count.skus },
    });
    reply.code(204);
    return null;
  });

  /**
   * Put a part in a group. One group per part, so this moves rather than adds when
   * the part is already charted; `groupId: null` takes it out of the chart.
   */
  app.post('/formulas/paint-colors/assign', manage, async (req) => {
    const b = (req.body || {}) as { sku?: string; groupId?: string | null };
    const sku = String(b.sku ?? '')
      .trim()
      .toUpperCase();
    if (!sku) throw new ValidationError('Give a part number');

    if (!b.groupId) {
      await prisma.paintColorGroupSku.deleteMany({ where: { sku } });
      await recordAudit({
        actorId: req.user!.sub,
        action: 'paintColor.assign',
        entity: 'PaintColorGroupSku',
        entityId: sku,
        details: { sku, group: null },
      });
      return { sku, groupId: null };
    }

    const group = await prisma.paintColorGroup.findUnique({ where: { id: b.groupId } });
    if (!group) throw new NotFoundError('That paint colour group no longer exists');
    const row = await prisma.paintColorGroupSku.upsert({
      where: { sku },
      create: { sku, groupId: group.id },
      update: { groupId: group.id },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paintColor.assign',
      entity: 'PaintColorGroupSku',
      entityId: row.id,
      details: { sku, group: group.name },
    });
    return row;
  });

  /**
   * Paste the chart: part number, group. The whole thing came out of a spreadsheet,
   * and typing forty rows one at a time is how a chart ends up half-loaded.
   * `dryRun` reports what would happen without writing.
   */
  app.post('/formulas/paint-colors/import', manage, async (req) => {
    const b = (req.body || {}) as { text?: string; dryRun?: boolean; overwrite?: boolean };
    const groups = await prisma.paintColorGroup.findMany();
    const byName = new Map(groups.map((g) => [g.name.toUpperCase(), g]));

    const rows: Array<{ sku: string; group: string }> = [];
    const errors: string[] = [];
    String(b.text ?? '')
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const line = raw.trim();
        if (!line) return;
        const cells = line
          .split(/\t|,|\s{2,}/)
          .map((c) => c.trim())
          .filter(Boolean);
        const [rawSku, rawGroup] = cells;
        if (!rawSku || !rawGroup) {
          errors.push(`Line ${i + 1}: needs a part number and a group.`);
          return;
        }
        // A pasted spreadsheet header ("SKU  Color Grouping") is not a mapping.
        if (i === 0 && /^(sku|part|item)/i.test(rawSku) && /group|colou?r/i.test(rawGroup)) return;
        const sku = rawSku.toUpperCase();
        const group = rawGroup.toUpperCase();
        if (!byName.has(group)) {
          errors.push(`Line ${i + 1}: there is no group called ${rawGroup}.`);
          return;
        }
        rows.push({ sku, group });
      });

    const existing = await prisma.paintColorGroupSku.findMany({
      where: { sku: { in: rows.map((r) => r.sku) } },
      include: { group: { select: { name: true } } },
    });
    const bySku = new Map(existing.map((r) => [r.sku.toUpperCase(), r]));

    const toCreate = rows.filter((r) => !bySku.has(r.sku));
    const toMove = rows.filter((r) => {
      const cur = bySku.get(r.sku);
      return !!cur && cur.group.name.toUpperCase() !== r.group;
    });
    const unchanged = rows.length - toCreate.length - toMove.length;

    if (b.dryRun) {
      return {
        dryRun: true,
        parsed: rows.length,
        created: toCreate.length,
        moved: b.overwrite ? toMove.length : 0,
        skipped: b.overwrite ? unchanged : unchanged + toMove.length,
        conflicts: b.overwrite
          ? []
          : toMove.map((r) => ({
              sku: r.sku,
              current: bySku.get(r.sku)!.group.name,
              incoming: r.group,
            })),
        errors,
      };
    }

    for (const r of toCreate) {
      await prisma.paintColorGroupSku.create({
        data: { sku: r.sku, groupId: byName.get(r.group)!.id },
      });
    }
    if (b.overwrite) {
      for (const r of toMove) {
        await prisma.paintColorGroupSku.update({
          where: { id: bySku.get(r.sku)!.id },
          data: { groupId: byName.get(r.group)!.id },
        });
      }
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paintColor.import',
      details: {
        created: toCreate.length,
        moved: b.overwrite ? toMove.length : 0,
        errors: errors.length,
      },
    });
    return {
      created: toCreate.length,
      moved: b.overwrite ? toMove.length : 0,
      skipped: b.overwrite ? unchanged : unchanged + toMove.length,
      errors,
    };
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
          return o
            ? ({ ...r, ...o, terms: (o.terms as FormulaRule['terms']) ?? r.terms } as FormulaRule)
            : r;
        })
      : base;

    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
    const evalSet = (rules: FormulaRule[]) => {
      if (kind === 'FRAME')
        return evaluateRules(
          rules,
          frameContext(answers, () => 0),
        );
      const bom = computeAdventureBOM(answers, saved.frame);
      const inputs: Record<string, number> = {
        bracketsQty: num(answers.bracketsQty),
        swivel360: num(answers.swivel360),
        swivelStandalone: num(answers.swivelStandalone),
        forged: num(answers.forged),
        swingHanger: num(answers.swingHanger),
        vRings: num(answers.vRings),
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
        const b = before.find((r) => r.part === p),
          a2 = after.find((r) => r.part === p);
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

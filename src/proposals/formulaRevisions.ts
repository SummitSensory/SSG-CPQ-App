import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { FORMULA_SETTINGS } from './formulaSettings.js';

/**
 * The formula revision log.
 *
 * Every change to an editable formula — frame and component quantities, hardware
 * fastener quantities, business numbers — is recorded here with a COMPLETE
 * snapshot of the rule either side of the change.
 *
 * Why a new table rather than a read of AuditLog: audit rows store the fields
 * that were SENT, which answers "who touched this" and cannot answer "what was it
 * before". Undo needs the before state, and so does anyone investigating a bill of
 * materials that came out wrong. Both snapshots are kept whole, so a revision
 * stays readable even after the workbook default it was overriding has itself
 * changed.
 *
 * ---------------------------------------------------------------------------
 * What "impacted orders" means, precisely
 *
 * A locked order's BOM quantities are a SNAPSHOT, taken from the proposal when
 * the order was created. Changing a formula does not reach back into them. So the
 * impact list is not "these orders will change" — nothing changes underneath
 * anyone. It is:
 *
 *   these open orders were built on the previous figures, and would come out
 *   differently if their bill of materials were rebuilt today.
 *
 * That is the fact an operator needs: it tells them which jobs to look at, and it
 * is honest about the direction of causation. The wording is used verbatim in the
 * UI and in the notification email, so all three agree.
 *
 * Scope is open orders only — anything not COMPLETE and not CANCELLED. A completed
 * order has already been built and shipped, and a cancelled one will not be built,
 * so neither is actionable.
 * ---------------------------------------------------------------------------
 */

const RESEND_URL = 'https://api.resend.com/emails';

/** Where formula-change notifications go. Overridable per deployment. */
const SALES_NOTIFY = (process.env.SALES_NOTIFY_EMAIL ?? 'sales@summitsensory.com')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

export type RevisionKind = 'FRAME' | 'HARDWARE' | 'SETTING';
export type RevisionAction = 'CREATE' | 'UPDATE' | 'RESET' | 'RESET_ALL' | 'UNDO';

/** The typed word the editor demands before a formula change is committed. */
export const CONFIRM_WORD = 'CONFIRMED';

/**
 * Check a typed confirmation. Case-insensitive and trimmed — the gate exists to
 * force a deliberate pause, and rejecting "confirmed " would only teach people to
 * distrust it.
 */
export function assertConfirmed(raw: unknown, what: string): string {
  const word = String(raw ?? '').trim();
  if (word.toUpperCase() !== CONFIRM_WORD)
    throw new ValidationError(`Type ${CONFIRM_WORD} to ${what}.`);
  return word;
}

export interface ImpactedOrder {
  id: string;
  number: string;
  customer: string | null;
}

/**
 * Open orders that would come out differently if rebuilt on the new figures.
 *
 * `parts` empty means the change is not part-specific (a business number), in
 * which case every open order qualifies — a deposit percentage or a mat rate
 * touches all of them.
 */
export async function impactedOrders(parts: string[]): Promise<ImpactedOrder[]> {
  const partList = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  const rows = await prisma.acceptedOrder.findMany({
    where: {
      status: { notIn: ['COMPLETE', 'CANCELLED'] },
      ...(partList.length ? { procurement: { some: { sku: { in: partList } } } } : {}),
    },
    // AcceptedOrder holds organizationId as a scalar with no relation field, so the
    // customer name is a second lookup — the same shape listOrders() uses.
    select: { id: true, number: true, organizationId: true },
    orderBy: { number: 'asc' },
  });
  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      })
    : [];
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    customer: orgName.get(r.organizationId) ?? null,
  }));
}

/** The sentence used for this list everywhere it appears. Kept in one place. */
export function impactSentence(count: number): string {
  if (count === 0)
    return 'No open order was built on the current figures, so nothing needs reviewing.';
  return (
    `${count} open ${count === 1 ? 'order was' : 'orders were'} built on the previous figures ` +
    `and would come out differently if ${count === 1 ? 'its' : 'their'} bill of materials were ` +
    'rebuilt today. Existing bills of materials are not changed by this edit.'
  );
}

/** A rule reduced to the fields that define it, for the before/after snapshots. */
export interface RuleSnapshot {
  part: string;
  name?: string | null;
  terms?: unknown;
  constant?: number;
  factor?: number;
  roundMode?: string;
  roundStep?: number;
  mode?: string;
  minZero?: boolean;
  active?: boolean;
  when?: unknown;
  group?: string | null;
  note?: string | null;
}

export interface RevisionInput {
  kind: RevisionKind;
  action: RevisionAction;
  target: string;
  targetName?: string | null;
  before?: unknown;
  after?: unknown;
  summary: string;
}

export interface WriteRevisionsArgs {
  actorId: string;
  confirmedWord: string | null;
  /** Part numbers the change touches; empty for business numbers. */
  parts: string[];
  entries: RevisionInput[];
  /** Set on an undo, so the reversed revision can be marked and linked. */
  undoesId?: string;
}

export interface WriteRevisionsResult {
  batchId: string;
  ids: string[];
  impacted: ImpactedOrder[];
  notifyError: string | null;
}

/**
 * Write one batch of revisions, snapshot the impacted orders, then notify sales.
 *
 * Order matters. The revisions are committed FIRST and the email is sent after,
 * because a mail failure must not roll back a formula change that has already
 * taken effect — the change is real either way, and a silently discarded edit is
 * worse than an unsent notification. The failure is recorded on the rows instead.
 */
export async function writeRevisions(args: WriteRevisionsArgs): Promise<WriteRevisionsResult> {
  if (!args.entries.length) return { batchId: '', ids: [], impacted: [], notifyError: null };

  const impacted = await impactedOrders(args.parts);
  const batchId = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const json = (v: unknown) =>
    v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

  const created = await prisma.$transaction(
    args.entries.map((e) =>
      prisma.formulaRevision.create({
        data: {
          batchId,
          kind: e.kind,
          action: e.action,
          target: e.target,
          targetName: e.targetName ?? null,
          before: json(e.before),
          after: json(e.after),
          summary: e.summary,
          confirmedWord: args.confirmedWord,
          impactedOrders: impacted as unknown as Prisma.InputJsonValue,
          impactedCount: impacted.length,
          actorId: args.actorId,
          ...(args.undoesId ? { undoesId: args.undoesId } : {}),
        },
        select: { id: true },
      }),
    ),
  );
  const ids = created.map((c) => c.id);

  if (args.undoesId) {
    await prisma.formulaRevision.update({
      where: { id: args.undoesId },
      data: { undoneAt: new Date(), undoneById: args.actorId },
    });
  }

  const notifyError = await notifySales(args.actorId, args.entries, impacted);
  await prisma.formulaRevision.updateMany({
    where: { id: { in: ids } },
    data: notifyError ? { notifyError } : { notifiedAt: new Date() },
  });

  return { batchId, ids, impacted, notifyError };
}

/** Human name for an actor, for the log and the email. Falls back to the id. */
async function actorName(actorId: string): Promise<string> {
  const u = await prisma.user
    .findUnique({ where: { id: actorId }, select: { name: true, email: true } })
    .catch(() => null);
  return u?.name || u?.email || actorId;
}

const KIND_LABEL: Record<RevisionKind, string> = {
  FRAME: 'Frame & components',
  HARDWARE: 'Hardware fasteners',
  SETTING: 'Business numbers',
};

/**
 * Email sales that a formula moved. Returns null on success, or the reason it
 * did not go out — never throws, for the reason given in writeRevisions.
 */
async function notifySales(
  actorId: string,
  entries: RevisionInput[],
  impacted: ImpactedOrder[],
): Promise<string | null> {
  if (!SALES_NOTIFY.length) return 'SALES_NOTIFY_EMAIL is not set — nobody was emailed.';
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not set — nobody was emailed.';

  const who = await actorName(actorId);
  // The confirmation time IS the time of writing: the revision is created in the
  // same request that accepted the typed word, so there is no second timestamp to
  // reconcile.
  const when = new Date().toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/New_York',
  });
  const sets = [...new Set(entries.map((e) => KIND_LABEL[e.kind]))].join(' and ');

  const lines = [
    `${who} changed ${sets} in the proposal management software.`,
    '',
    `Confirmed: ${when} (Eastern)`,
    `Changed by: ${who}`,
    '',
    entries.length === 1 ? 'The change:' : `The changes (${entries.length}):`,
    ...entries.map((e) => `  · ${e.summary}`),
    '',
    impactSentence(impacted.length),
  ];
  if (impacted.length) {
    lines.push('');
    lines.push('Open orders to review:');
    for (const o of impacted) lines.push(`  · ${o.number}${o.customer ? ` — ${o.customer}` : ''}`);
  }

  const subject =
    entries.length === 1
      ? `Formula change: ${entries[0]!.summary}`
      : `Formula change: ${entries.length} rows in ${sets}`;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to: SALES_NOTIFY,
        reply_to: env.BOM_REPLY_TO,
        subject,
        text: lines.join('\n'),
      }),
    });
    if (!res.ok) return `Resend rejected the notification (${res.status})`;
    return null;
  } catch (e) {
    logger.warn({ err: e }, 'formula revision: sales notification failed');
    return e instanceof Error ? e.message : 'notification failed';
  }
}

export interface RevisionRow {
  id: string;
  batchId: string;
  kind: RevisionKind;
  action: RevisionAction;
  target: string;
  targetName: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  confirmedWord: string | null;
  impactedCount: number;
  impactedOrders: ImpactedOrder[];
  notifiedAt: string | null;
  notifyError: string | null;
  undoneAt: string | null;
  undoneByName: string | null;
  undoesId: string | null;
  /** True when this row can still be undone: not already undone, not itself an undo. */
  undoable: boolean;
  actorId: string;
  actorName: string;
  createdAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * The log. `kind` scopes it to one tab; omit for the combined view.
 */
export async function listRevisions(
  opts: {
    kind?: RevisionKind;
    limit?: number;
  } = {},
): Promise<RevisionRow[]> {
  const rows = await prisma.formulaRevision.findMany({
    where: opts.kind ? { kind: opts.kind } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(opts.limit) || 500, 1), 2000),
  });

  const ids = [
    ...new Set(rows.flatMap((r) => [r.actorId, r.undoneById]).filter(Boolean) as string[]),
  ];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email || u.id]));

  return rows.map((r) => ({
    id: r.id,
    batchId: r.batchId,
    kind: r.kind as RevisionKind,
    action: r.action as RevisionAction,
    target: r.target,
    targetName: r.targetName,
    summary: r.summary,
    before: r.before ?? null,
    after: r.after ?? null,
    confirmedWord: r.confirmedWord,
    impactedCount: r.impactedCount,
    impactedOrders: (r.impactedOrders as unknown as ImpactedOrder[]) ?? [],
    notifiedAt: iso(r.notifiedAt),
    notifyError: r.notifyError,
    undoneAt: iso(r.undoneAt),
    undoneByName: r.undoneById ? (nameById.get(r.undoneById) ?? null) : null,
    undoesId: r.undoesId,
    undoable: !r.undoneAt && r.action !== 'UNDO',
    actorId: r.actorId,
    actorName: nameById.get(r.actorId) ?? r.actorId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revisionDetail(id: string): Promise<RevisionRow> {
  const one = await prisma.formulaRevision.findUnique({ where: { id } });
  if (!one) throw new NotFoundError('That revision no longer exists');
  const rows = await listRevisions({ kind: one.kind as RevisionKind, limit: 2000 });
  const hit = rows.find((r) => r.id === id);
  if (!hit) throw new NotFoundError('That revision no longer exists');
  return hit;
}

/**
 * Reverse one revision: put that row back to the value it held immediately
 * before the change, and record the reversal as a revision of its own.
 *
 * Deliberately narrow. It restores ONE row, not the whole batch, and it restores
 * the recorded `before` rather than the workbook default — those are different
 * things whenever the row had already been overridden once. Undoing a row twice
 * is refused rather than silently re-applied.
 *
 * The caller enforces that only a system administrator may reach this.
 */
export async function undoRevision(id: string, actorId: string): Promise<WriteRevisionsResult> {
  const rev = await prisma.formulaRevision.findUnique({ where: { id } });
  if (!rev) throw new NotFoundError('That revision no longer exists');
  if (rev.undoneAt) throw new ValidationError('That change has already been undone.');
  if (rev.action === 'UNDO')
    throw new ValidationError('That entry is itself an undo. Undo the original change instead.');

  const kind = rev.kind as RevisionKind;
  const before = rev.before as Record<string, unknown> | null;

  if (kind === 'SETTING') {
    const def = FORMULA_SETTINGS.find((d) => d.key === rev.target);
    const label = def?.label ?? rev.target;
    if (before && before.value != null) {
      const value = Number(before.value);
      if (!Number.isFinite(value))
        throw new ValidationError(`The recorded previous value for ${label} is not a number.`);
      await prisma.formulaSetting.upsert({
        where: { key: rev.target },
        create: { key: rev.target, value, updatedById: actorId },
        update: { value, updatedById: actorId },
      });
      return writeRevisions({
        actorId,
        confirmedWord: null,
        parts: [],
        undoesId: id,
        entries: [
          {
            kind,
            action: 'UNDO',
            target: rev.target,
            targetName: label,
            before: rev.after,
            after: before,
            summary: `Undid: ${rev.summary} — ${label} put back to ${value}`,
          },
        ],
      });
    }
    // No prior override existed, so undoing means removing the override entirely.
    await prisma.formulaSetting.deleteMany({ where: { key: rev.target } });
    return writeRevisions({
      actorId,
      confirmedWord: null,
      parts: [],
      undoesId: id,
      entries: [
        {
          kind,
          action: 'UNDO',
          target: rev.target,
          targetName: label,
          before: rev.after,
          after: null,
          summary: `Undid: ${rev.summary} — ${label} back on its workbook default`,
        },
      ],
    });
  }

  // FRAME / HARDWARE.
  const name = rev.targetName ?? rev.target;
  if (!before) {
    // The rule had no override before, so the undo is a reset.
    await prisma.hardwareRule.deleteMany({ where: { part: rev.target, kind } });
    return writeRevisions({
      actorId,
      confirmedWord: null,
      parts: [rev.target],
      undoesId: id,
      entries: [
        {
          kind,
          action: 'UNDO',
          target: rev.target,
          targetName: name,
          before: rev.after,
          after: null,
          summary: `Undid: ${rev.summary} — ${rev.target} back on its workbook default`,
        },
      ],
    });
  }

  const data = {
    kind,
    name: String(before.name ?? name),
    terms: (before.terms ?? []) as object,
    constant: Number(before.constant ?? 0),
    factor: Number(before.factor ?? 1),
    roundMode: String(before.roundMode ?? 'NONE'),
    roundStep: Number(before.roundStep ?? 1),
    mode: String(before.mode ?? 'SUM'),
    minZero: before.minZero !== false,
    sortOrder: Number(before.sortOrder ?? 999),
    active: before.active !== false,
    group: (before.group ?? null) as string | null,
    when: before.when == null ? Prisma.DbNull : (before.when as unknown as Prisma.InputJsonValue),
    note: (before.note ?? null) as string | null,
    updatedById: actorId,
  };
  const existing = await prisma.hardwareRule.findFirst({
    where: { part: rev.target, kind },
    select: { id: true },
  });
  if (existing) await prisma.hardwareRule.update({ where: { id: existing.id }, data });
  else await prisma.hardwareRule.create({ data: { part: rev.target, ...data } });

  return writeRevisions({
    actorId,
    confirmedWord: null,
    parts: [rev.target],
    undoesId: id,
    entries: [
      {
        kind,
        action: 'UNDO',
        target: rev.target,
        targetName: name,
        before: rev.after,
        after: before,
        summary: `Undid: ${rev.summary}`,
      },
    ],
  });
}

/**
 * One-line description of what moved between two rule snapshots.
 *
 * Composed at write time and stored, so the log and the Excel export never
 * re-derive wording — and so a change of editor cannot retroactively alter how a
 * historic entry reads.
 */
export function describeRuleChange(
  part: string,
  name: string,
  before: RuleSnapshot | null,
  after: RuleSnapshot | null,
): string {
  const label = `${part} (${name})`;
  if (!before && after) return `${label}: new override added`;
  if (before && !after) return `${label}: override cleared, back on the workbook default`;
  if (!before || !after) return `${label}: changed`;

  const moved: string[] = [];
  const num = (k: keyof RuleSnapshot, pretty: string) => {
    const a = Number(before[k] ?? 0),
      b = Number(after[k] ?? 0);
    if (a !== b) moved.push(`${pretty} ${a} → ${b}`);
  };
  num('constant', 'constant');
  num('factor', 'factor');
  num('roundStep', 'rounding step');
  if (String(before.roundMode) !== String(after.roundMode))
    moved.push(`rounding ${before.roundMode} → ${after.roundMode}`);
  if (String(before.mode) !== String(after.mode)) moved.push(`mode ${before.mode} → ${after.mode}`);
  if (before.minZero !== after.minZero)
    moved.push(`never negative ${before.minZero ? 'on' : 'off'} → ${after.minZero ? 'on' : 'off'}`);
  if (before.active !== after.active)
    moved.push(after.active ? 'switched back on' : 'switched off — always 0');
  if (String(before.name ?? '') !== String(after.name ?? ''))
    moved.push(`renamed to "${after.name}"`);
  if (JSON.stringify(before.terms ?? []) !== JSON.stringify(after.terms ?? []))
    moved.push(
      `formula terms changed (${(before.terms as unknown[] | undefined)?.length ?? 0} → ${
        (after.terms as unknown[] | undefined)?.length ?? 0
      })`,
    );
  if (JSON.stringify(before.when ?? null) !== JSON.stringify(after.when ?? null))
    moved.push('condition changed');
  if (String(before.note ?? '') !== String(after.note ?? '')) moved.push('note changed');

  return moved.length ? `${label}: ${moved.join('; ')}` : `${label}: saved with no change`;
}

/** The same, for a business number. */
export function describeSettingChange(key: string, from: number | null, to: number | null): string {
  const def = FORMULA_SETTINGS.find((d) => d.key === key);
  const label = def?.label ?? key;
  const unit = def?.unit ? ` ${def.unit}` : '';
  if (to == null) return `${label}: back on its workbook default`;
  if (from == null) return `${label}: set to ${to}${unit}`;
  return `${label}: ${from}${unit} → ${to}${unit}`;
}

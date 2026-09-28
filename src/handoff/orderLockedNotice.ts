import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ValidationError } from '../lib/errors.js';

/**
 * The "an order has been locked" email.
 *
 * Sent to an internal list an administrator keeps under Settings → Email, the moment
 * a signed proposal becomes an order — whichever screen locked it. The list lives in
 * UiSetting rather than an environment variable so changing who hears about new
 * orders is a settings change, not a redeploy. The subject and body are editable
 * there too (see "the wording" below).
 *
 * Not sendAlert (lib/alerts.ts): that path is for faults — fire-and-forget, a stack
 * trace in the body, and repeats suppressed for an hour. This is a business notice:
 * one per order, awaited, and what happened to it is written on the order's
 * timeline so "did anyone get told?" has an answer.
 *
 * Never throws. A mail failure must not fail, or appear to fail, an order lock that
 * has already been committed.
 */

const RESEND_URL = 'https://api.resend.com/emails';
export const ORDER_LOCKED_RECIPIENTS_KEY = 'notify.orderLocked.recipients';
const MAX_RECIPIENTS = 25;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** The saved list, normalised. Empty when nobody is set up to receive it. */
export async function loadOrderLockedRecipients(): Promise<string[]> {
  const row = await prisma.uiSetting.findUnique({ where: { key: ORDER_LOCKED_RECIPIENTS_KEY } });
  return parseRecipients(row?.value ?? '');
}

export function parseRecipients(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const a = raw.trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Validate and store the list. Blank clears it (nobody is emailed). */
export async function saveOrderLockedRecipients(
  input: unknown,
  actorId: string,
): Promise<string[]> {
  const list = Array.isArray(input)
    ? parseRecipients(input.filter((x): x is string => typeof x === 'string').join(','))
    : typeof input === 'string'
      ? parseRecipients(input)
      : null;
  if (!list) throw new ValidationError('Recipients must be a list of email addresses.');
  const bad = list.filter((a) => !EMAIL.test(a));
  if (bad.length) throw new ValidationError(`Not an email address: ${bad.join(', ')}`);
  if (list.length > MAX_RECIPIENTS)
    throw new ValidationError(`At most ${MAX_RECIPIENTS} recipients.`);
  if (!list.length) {
    await prisma.uiSetting.deleteMany({ where: { key: ORDER_LOCKED_RECIPIENTS_KEY } });
    return [];
  }
  const value = list.join(', ');
  await prisma.uiSetting.upsert({
    where: { key: ORDER_LOCKED_RECIPIENTS_KEY },
    create: { key: ORDER_LOCKED_RECIPIENTS_KEY, value, updatedById: actorId },
    update: { value, updatedById: actorId },
  });
  return list;
}

const money = (minor: bigint | number, currency: string) =>
  `${currency} ${(Number(minor) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function baseUrl(): string | null {
  const configured = env.APP_BASE_URL ?? env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null;
}

export interface OrderLockedEmail {
  subject: string;
  text: string;
}

/* ------------------------------------------------------------ the wording */

/**
 * The subject and body are templates an administrator edits under Settings → Email,
 * stored in UiSetting beside the recipient list. Nothing saved means the defaults
 * below, which are the wording this email shipped with.
 *
 * Merge fields are `{{snake_case}}`, the same convention as the payment letters
 * (email/paymentTemplates.ts), and deliberately not a template language: no
 * conditionals. The one piece of logic the old hard-coded email had — leave out a
 * line for something this order does not have, e.g. no customer PO — is kept as a
 * rule instead: a body line whose merge fields are ALL empty is dropped. Plain text,
 * so there is nothing to escape.
 */
export const ORDER_LOCKED_SUBJECT_KEY = 'notify.orderLocked.subject';
export const ORDER_LOCKED_BODY_KEY = 'notify.orderLocked.body';
const MAX_SUBJECT = 300;
const MAX_BODY = 10_000;

export const ORDER_LOCKED_FIELDS: Array<{ token: string; means: string }> = [
  { token: 'order_number', means: 'Order number, e.g. SO-2026-000042' },
  { token: 'customer', means: 'The customer organization' },
  { token: 'project', means: 'The project (opportunity) name' },
  { token: 'proposal', means: 'Proposal, version and title together' },
  { token: 'proposal_number', means: 'Proposal number' },
  { token: 'proposal_version', means: 'Accepted proposal version' },
  { token: 'proposal_title', means: 'Proposal title' },
  { token: 'order_total', means: 'Order total, with currency' },
  { token: 'deposit_due', means: 'Deposit due, or "None"' },
  { token: 'approved_by', means: 'Who approved it for the customer' },
  { token: 'customer_po', means: 'The customer’s PO number' },
  { token: 'locked_by', means: 'Who locked the order' },
  { token: 'locked_at', means: 'When it was locked (Mountain time)' },
  { token: 'order_link', means: 'Link to the order in the app' },
];

export const DEFAULT_ORDER_LOCKED_SUBJECT = 'Order locked: {{order_number}} — {{customer}}';
export const DEFAULT_ORDER_LOCKED_BODY = [
  'Order {{order_number}} has been locked for {{customer}}.',
  '',
  'Order:        {{order_number}}',
  'Customer:     {{customer}}',
  'Project:      {{project}}',
  'Proposal:     {{proposal}}',
  'Order total:  {{order_total}}',
  'Deposit due:  {{deposit_due}}',
  'Approved by:  {{approved_by}}',
  'Customer PO:  {{customer_po}}',
  'Locked by:    {{locked_by}}',
  'Locked at:    {{locked_at}} (Mountain)',
  '',
  'Open the order: {{order_link}}',
].join('\n');

export interface OrderLockedTemplate {
  subject: string;
  body: string;
}

const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const KNOWN = new Set(ORDER_LOCKED_FIELDS.map((f) => f.token));

/** Fields a template uses that do not exist — almost always a typo. */
export function unknownFields(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[1]!.toLowerCase();
    if (!KNOWN.has(name)) out.add(name);
  }
  return [...out];
}

function fill(line: string, values: Record<string, string>): string {
  return line.replace(TOKEN_RE, (_all, name: string) => values[name.toLowerCase()] ?? '');
}

/** Render a template against one order's values. */
export function renderOrderLockedEmail(
  template: OrderLockedTemplate,
  values: Record<string, string>,
): OrderLockedEmail {
  // Blank means "the default", the same as saving it blank.
  const body = template.body.trim() ? template.body : DEFAULT_ORDER_LOCKED_BODY;
  const lines: string[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = [...line.matchAll(TOKEN_RE)].map((m) => m[1]!.toLowerCase());
    // A line built only around fields this order does not have is left out, not
    // printed as "Customer PO:" with nothing after it.
    if (tokens.length && tokens.every((t) => !values[t])) continue;
    lines.push(fill(line, values).trimEnd());
  }
  const text =
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  const subject =
    fill(template.subject, values).replace(/\s+/g, ' ').trim() ||
    fill(DEFAULT_ORDER_LOCKED_SUBJECT, values);
  return { subject, text };
}

/** The saved wording, or the default for whichever part has not been changed. */
export async function loadOrderLockedTemplate(): Promise<OrderLockedTemplate> {
  const rows = await prisma.uiSetting.findMany({
    where: { key: { in: [ORDER_LOCKED_SUBJECT_KEY, ORDER_LOCKED_BODY_KEY] } },
  });
  const saved = (key: string) => rows.find((r) => r.key === key)?.value?.trim() || null;
  return {
    subject: saved(ORDER_LOCKED_SUBJECT_KEY) ?? DEFAULT_ORDER_LOCKED_SUBJECT,
    body: saved(ORDER_LOCKED_BODY_KEY) ?? DEFAULT_ORDER_LOCKED_BODY,
  };
}

/** Check a subject/body pair; throws a message an administrator can act on. */
export function validateOrderLockedTemplate(input: unknown): OrderLockedTemplate {
  const o = (input ?? {}) as { subject?: unknown; body?: unknown };
  if (typeof o.subject !== 'string' || typeof o.body !== 'string')
    throw new ValidationError('Subject and body must both be text.');
  const subject = o.subject.replace(/[\r\n]+/g, ' ').trim();
  const body = o.body.replace(/\r\n?/g, '\n').trim();
  if (subject.length > MAX_SUBJECT)
    throw new ValidationError(`The subject can be at most ${MAX_SUBJECT} characters.`);
  if (body.length > MAX_BODY)
    throw new ValidationError(`The body can be at most ${MAX_BODY} characters.`);
  const unknown = unknownFields(subject + '\n' + body);
  if (unknown.length)
    throw new ValidationError(
      `Unknown merge field${unknown.length === 1 ? '' : 's'}: ${unknown
        .map((u) => `{{${u}}}`)
        .join(', ')}. Use one from the list.`,
    );
  return { subject, body };
}

/**
 * Save the wording. A blank part — or one identical to the default — is stored as
 * nothing, so it keeps following the default if that is ever improved.
 */
export async function saveOrderLockedTemplate(
  input: unknown,
  actorId: string,
): Promise<OrderLockedTemplate> {
  const t = validateOrderLockedTemplate(input);
  const parts: Array<[string, string, string]> = [
    [ORDER_LOCKED_SUBJECT_KEY, t.subject, DEFAULT_ORDER_LOCKED_SUBJECT],
    [ORDER_LOCKED_BODY_KEY, t.body, DEFAULT_ORDER_LOCKED_BODY],
  ];
  for (const [key, value, fallback] of parts) {
    if (!value || value === fallback) {
      await prisma.uiSetting.deleteMany({ where: { key } });
    } else {
      await prisma.uiSetting.upsert({
        where: { key },
        create: { key, value, updatedById: actorId },
        update: { value, updatedById: actorId },
      });
    }
  }
  return loadOrderLockedTemplate();
}

/* ------------------------------------------------------------ the email */

/**
 * The email itself, from the order as it was just written. `template` overrides
 * the saved wording — the Settings preview renders an unsaved draft this way.
 */
export async function buildOrderLockedEmail(
  orderId: string,
  template?: OrderLockedTemplate,
): Promise<OrderLockedEmail | null> {
  const values = await orderLockedValues(orderId);
  if (!values) return null;
  return renderOrderLockedEmail(template ?? (await loadOrderLockedTemplate()), values);
}

/** The merge-field values for one order. Empty string = this order has none. */
async function orderLockedValues(orderId: string): Promise<Record<string, string> | null> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      organizationId: true,
      opportunityId: true,
      proposalId: true,
      acceptedVersion: true,
      currency: true,
      grandTotalMinor: true,
      depositRequired: true,
      depositDueMinor: true,
      acceptedById: true,
      createdAt: true,
      customerApproval: { select: { approverName: true, method: true, poNumber: true } },
    },
  });
  if (!order) return null;
  const [org, proposal, opportunity, actor] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: order.organizationId },
      select: { name: true },
    }),
    prisma.proposal.findUnique({
      where: { id: order.proposalId },
      select: { number: true, title: true },
    }),
    order.opportunityId
      ? prisma.opportunity.findUnique({
          where: { id: order.opportunityId },
          select: { name: true },
        })
      : null,
    prisma.user.findUnique({
      where: { id: order.acceptedById },
      select: { name: true, email: true },
    }),
  ]);
  const customer = org?.name ?? 'Unknown customer';
  const base = baseUrl();
  const when = order.createdAt.toLocaleString('en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const approval = order.customerApproval;
  return {
    order_number: order.number,
    customer,
    project: opportunity?.name ?? '',
    proposal: proposal
      ? `${proposal.number} (version ${order.acceptedVersion})${proposal.title ? ` — ${proposal.title}` : ''}`
      : '',
    proposal_number: proposal?.number ?? '',
    proposal_version: proposal ? String(order.acceptedVersion) : '',
    proposal_title: proposal?.title ?? '',
    order_total: money(order.grandTotalMinor, order.currency),
    deposit_due: order.depositRequired ? money(order.depositDueMinor, order.currency) : 'None',
    approved_by: approval?.approverName ?? '',
    customer_po: approval?.poNumber ?? '',
    locked_by: actor?.name || actor?.email || 'Unknown user',
    locked_at: when,
    order_link: base ? `${base}/?order=${encodeURIComponent(order.id)}` : '',
  };
}

interface Delivery {
  to: string[];
  email: OrderLockedEmail;
  idempotencyKey?: string;
}

/**
 * One POST to Resend. Returns null when it was accepted, or why not — including
 * Resend's own explanation, since a bare status ("403") does not say whether the
 * key, the sending domain or an address is at fault.
 */
async function deliver({ to, email, idempotencyKey }: Delivery): Promise<string | null> {
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not set — nobody was emailed.';
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: `${env.ALERT_FROM_NAME} <${env.ALERT_FROM_EMAIL}>`,
      to,
      reply_to: env.BOM_REPLY_TO,
      subject: email.subject,
      text: email.text,
    }),
  });
  if (res.ok) return null;
  let reason = '';
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') reason = body.message;
  } catch {
    // Not JSON — the status is all there is.
  }
  return `Resend rejected the notice (${res.status})${reason ? `: ${reason}` : '.'}`;
}

/**
 * Send the notice for an order and record the outcome on the order's timeline.
 * Returns null when it was sent, or why it was not.
 *
 * `resend` is an administrator sending it again by hand (Settings → Email), e.g.
 * after a delivery fault is fixed. It needs its own idempotency key so the automatic
 * send's key cannot swallow it; the key is numbered by the attempts already on the
 * order, so a double click still sends once.
 */
export async function sendOrderLockedNotice(
  orderId: string,
  actorId: string,
  opts: { resend?: boolean } = {},
): Promise<string | null> {
  let outcome: string | null;
  let to: string[] = [];
  try {
    to = await loadOrderLockedRecipients();
    if (!to.length) {
      // Nobody set up is a choice, not a fault — nothing to record.
      return 'No order-locked recipients are set (Settings → Email).';
    }
    if (!env.RESEND_API_KEY) {
      outcome = 'RESEND_API_KEY is not set — nobody was emailed.';
    } else {
      const email = await buildOrderLockedEmail(orderId);
      if (!email) return 'Order not found.';
      let idempotencyKey = `order-locked-${orderId}`;
      if (opts.resend) {
        const attempts = await prisma.orderEvent.count({
          where: { orderId, action: { startsWith: 'order.locked.notice' } },
        });
        idempotencyKey += `-resend-${attempts}`;
      }
      outcome = await deliver({ to, email, idempotencyKey });
    }
  } catch (err) {
    outcome = err instanceof Error ? err.message : 'the notice could not be sent';
  }
  if (outcome) logger.warn({ orderId, outcome }, 'order locked notice not sent');
  try {
    await prisma.orderEvent.create({
      data: {
        orderId,
        action: outcome ? 'order.locked.notice_failed' : 'order.locked.notice_sent',
        actorId,
        detail: {
          to,
          ...(opts.resend ? { resend: true } : {}),
          ...(outcome ? { error: outcome } : {}),
        } as object,
      },
    });
  } catch (err) {
    logger.warn({ err, orderId }, 'order locked notice: event not recorded');
  }
  return outcome;
}

/**
 * Settings → Email → "Send test": the same sender, key and recipients as the real
 * notice, so a pass here means the next locked order will be announced. The body is
 * the most recent order's, marked as a test (a placeholder when there are no orders
 * yet). Nothing is written to any order's timeline.
 */
export async function sendOrderLockedTestEmail(): Promise<{
  to: string[];
  error: string | null;
}> {
  let to: string[] = [];
  try {
    to = await loadOrderLockedRecipients();
    if (!to.length)
      return { to, error: 'No order-locked recipients are set — save the list first.' };
    const { email: sample } = await previewOrderLockedEmail(await loadOrderLockedTemplate());
    const note =
      'TEST — a test of the order-locked email, sent from Settings → Email. ' +
      'No order was locked.\n\n';
    const email: OrderLockedEmail = {
      subject: `[TEST] ${sample.subject}`,
      text: note + sample.text,
    };
    return { to, error: await deliver({ to, email }) };
  } catch (err) {
    return { to, error: err instanceof Error ? err.message : 'the test could not be sent' };
  }
}

/** Stand-in values for a preview when no order has been locked yet. */
export const SAMPLE_ORDER_LOCKED_VALUES: Record<string, string> = {
  order_number: 'SO-2026-000000',
  customer: 'Sample Customer',
  project: 'Sample Project',
  proposal: 'P-2026-000000 (version 1) — Sample Proposal',
  proposal_number: 'P-2026-000000',
  proposal_version: '1',
  proposal_title: 'Sample Proposal',
  order_total: 'USD 10,000.00',
  deposit_due: 'USD 5,000.00',
  approved_by: 'Jane Customer',
  customer_po: 'PO-1234',
  locked_by: 'A. User',
  locked_at: 'Jan 1, 2026, 9:00 AM',
  order_link: 'https://example.com/?order=sample',
};

/**
 * A template rendered against the most recently locked order (sample values when
 * there is none), for the Settings preview and the test send.
 */
export async function previewOrderLockedEmail(
  template: OrderLockedTemplate,
): Promise<{ email: OrderLockedEmail; basedOn: string | null }> {
  const latest = await prisma.acceptedOrder.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true },
  });
  const values = latest ? await orderLockedValues(latest.id) : null;
  return {
    email: renderOrderLockedEmail(template, values ?? SAMPLE_ORDER_LOCKED_VALUES),
    basedOn: values && latest ? latest.number : null,
  };
}

/** An order by its number (SO-2026-000042) or id, for the hand re-send. */
export async function findOrderForNotice(ref: string) {
  const r = ref.trim();
  if (!r) return null;
  return prisma.acceptedOrder.findFirst({
    where: { OR: [{ number: { equals: r, mode: 'insensitive' } }, { id: r }] },
    select: { id: true, number: true },
  });
}

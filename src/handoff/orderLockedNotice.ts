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
 * orders is a settings change, not a redeploy.
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

/** The email itself, from the order as it was just written. */
export async function buildOrderLockedEmail(orderId: string): Promise<OrderLockedEmail | null> {
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
  // null = a field this order does not have; the line is left out, not left blank.
  const lines: Array<string | null> = [
    `Order ${order.number} has been locked for ${customer}.`,
    '',
    `Order:        ${order.number}`,
    `Customer:     ${customer}`,
    opportunity?.name ? `Project:      ${opportunity.name}` : null,
    proposal
      ? `Proposal:     ${proposal.number} (version ${order.acceptedVersion})${proposal.title ? ` — ${proposal.title}` : ''}`
      : null,
    `Order total:  ${money(order.grandTotalMinor, order.currency)}`,
    `Deposit due:  ${order.depositRequired ? money(order.depositDueMinor, order.currency) : 'None'}`,
    approval?.approverName ? `Approved by:  ${approval.approverName}` : null,
    approval?.poNumber ? `Customer PO:  ${approval.poNumber}` : null,
    `Locked by:    ${actor?.name || actor?.email || 'Unknown user'}`,
    `Locked at:    ${when} (Mountain)`,
    ...(base ? ['', `Open the order: ${base}/?order=${encodeURIComponent(order.id)}`] : []),
  ];
  return {
    subject: `Order locked: ${order.number} — ${customer}`,
    text: lines.filter((l): l is string => l !== null).join('\n') + '\n',
  };
}

/**
 * Send the notice for an order that has just been locked, and record the outcome on
 * the order's timeline. Returns null when it was sent, or why it was not.
 */
export async function sendOrderLockedNotice(
  orderId: string,
  actorId: string,
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
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          // One notice per order, even if a retry reaches here twice.
          'Idempotency-Key': `order-locked-${orderId}`,
        },
        body: JSON.stringify({
          from: `${env.ALERT_FROM_NAME} <${env.ALERT_FROM_EMAIL}>`,
          to,
          reply_to: env.BOM_REPLY_TO,
          subject: email.subject,
          text: email.text,
        }),
      });
      outcome = res.ok ? null : `Resend rejected the notice (${res.status}).`;
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
        detail: (outcome ? { to, error: outcome } : { to }) as object,
      },
    });
  } catch (err) {
    logger.warn({ err, orderId }, 'order locked notice: event not recorded');
  }
  return outcome;
}

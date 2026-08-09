import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { documentPdf, syncTransactionState } from './billing.js';

/**
 * Payment reminders for an outstanding invoice.
 *
 * Sent from our own domain rather than through QuickBooks, which is the
 * opposite of the invoice itself. The reasoning: the invoice is an accounting
 * document and belongs in QuickBooks' sent history, but a reminder is a
 * conversation with a customer a rep already knows. It should come from Summit,
 * read like a person wrote it, and land in the thread the rep is already in —
 * QuickBooks' own reminder is a template no one here can edit.
 *
 * The invoice PDF is attached, fetched live from QuickBooks at send time so the
 * customer is looking at the current document rather than a copy that predates
 * an edit.
 *
 * Every reminder is refused unless the balance is currently outstanding, and
 * the balance is re-read from QuickBooks immediately before composing. Chasing
 * a customer who paid last week is the failure mode worth engineering against.
 */

const RESEND_URL = 'https://api.resend.com/emails';

function money(minor: bigint, currency = 'USD'): string {
  const n = Number(minor) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency });
}

function longDate(d: Date | null): string {
  return d
    ? d.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';
}

export interface ReminderDraft {
  transactionId: string;
  docNumber: string | null;
  customerName: string;
  toEmail: string | null;
  balanceMinor: string;
  totalMinor: string;
  paidMinor: string;
  currency: string;
  dueDate: string | null;
  daysOverdue: number;
  subject: string;
  body: string;
  /** Blocking reasons — the UI disables the send and shows these. */
  blockers: string[];
}

async function loadForReminder(txnId: string) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.type === 'ESTIMATE') throw new ValidationError('An estimate has no balance to chase');
  if (txn.status !== 'CREATED' || !txn.qboId) {
    throw new ConflictError('This invoice has not been created in QuickBooks yet');
  }
  const proposal = await prisma.proposal.findUnique({
    where: { id: txn.proposalId },
    select: { number: true, organizationId: true },
  });
  const org = proposal
    ? await prisma.organization.findUnique({
        where: { id: proposal.organizationId },
        select: { id: true, name: true },
      })
    : null;
  return { txn, proposal, org };
}

/**
 * Compose the reminder without sending it. Re-syncs from QuickBooks first, so
 * the balance quoted in the draft is the balance as of this moment.
 */
export async function draftReminder(
  txnId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReminderDraft> {
  await syncTransactionState(txnId, fetchImpl).catch((err) => {
    logger.warn({ err, txnId }, 'reminder draft: could not refresh from QuickBooks');
    return null;
  });

  const { txn, org } = await loadForReminder(txnId);
  const balance = txn.balanceMinor ?? txn.amountMinor;
  const total = txn.qboTotalMinor ?? txn.amountMinor;
  const paid = txn.paidMinor ?? 0n;
  const customerName = org?.name ?? 'there';

  const blockers: string[] = [];
  if (balance <= 0n)
    blockers.push('This invoice is paid in full — there is nothing to remind them about.');
  if (!txn.sentAt)
    blockers.push('This invoice has not been sent to the customer yet. Send it before chasing it.');
  if (!env.RESEND_API_KEY) blockers.push('Email is not configured on this deployment.');

  const daysOverdue = txn.dueDate
    ? Math.floor((Date.now() - txn.dueDate.getTime()) / 86_400_000)
    : 0;

  const doc = txn.qboDocNumber ? `invoice ${txn.qboDocNumber}` : 'your invoice';
  const subject = `${daysOverdue > 0 ? 'Past due' : 'Payment reminder'} — ${txn.qboDocNumber ?? 'Summit Sensory Gym'}`;

  // Written plainly and without pressure. A first reminder is usually a
  // forwarding problem inside the customer's own accounts payable, not a
  // refusal to pay, and the tone that gets it paid is the one that assumes so.
  const lines = [
    `Hello ${customerName},`,
    '',
    paid > 0n
      ? `This is a reminder about the remaining balance on ${doc}. Of ${money(total, txn.currency)}, ${money(paid, txn.currency)} has been received and ${money(balance, txn.currency)} is still outstanding.`
      : `This is a reminder that ${doc}, for ${money(balance, txn.currency)}, is still outstanding.`,
    txn.dueDate
      ? daysOverdue > 0
        ? `It was due on ${longDate(txn.dueDate)}, ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} ago.`
        : `It is due on ${longDate(txn.dueDate)}.`
      : '',
    '',
    'A copy of the invoice is attached. It can be paid using the link on the invoice, or by check to the address shown on it.',
    '',
    'If it has already been paid, or if it needs to go to someone else in your accounts payable, let me know and I will get it sorted.',
    '',
    'Thank you,',
    'Summit Sensory Gym',
  ];

  return {
    transactionId: txn.id,
    docNumber: txn.qboDocNumber,
    customerName: org?.name ?? '',
    toEmail: txn.sentToEmail,
    balanceMinor: balance.toString(),
    totalMinor: total.toString(),
    paidMinor: paid.toString(),
    currency: txn.currency,
    dueDate: txn.dueDate?.toISOString().slice(0, 10) ?? null,
    daysOverdue: Math.max(0, daysOverdue),
    subject,
    body: lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'),
    blockers,
  };
}

export interface SendReminderInput {
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  attachInvoice?: boolean;
}

export async function sendReminder(
  txnId: string,
  userId: string,
  userName: string,
  input: SendReminderInput,
  fetchImpl: typeof fetch = fetch,
) {
  if (!env.RESEND_API_KEY) throw new ValidationError('Email is not configured on this deployment');

  const recipients = input.to
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) throw new ValidationError('Give at least one recipient');
  for (const r of recipients) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))
      throw new ValidationError(`"${r}" is not a valid email address`);
  }
  if (!input.subject.trim()) throw new ValidationError('Give the reminder a subject');
  if (!input.body.trim()) throw new ValidationError('The reminder has no message');

  // Re-read the balance rather than trusting what the browser had on screen.
  // The draft may have been open for an hour.
  await syncTransactionState(txnId, fetchImpl).catch(() => null);
  const { txn, org } = await loadForReminder(txnId);
  const balance = txn.balanceMinor ?? txn.amountMinor;
  if (balance <= 0n) {
    throw new ConflictError('This invoice has been paid in full — no reminder was sent.');
  }

  const attachments: Array<{ filename: string; content: string }> = [];
  if (input.attachInvoice !== false) {
    try {
      const { pdf, filename } = await documentPdf(txnId, fetchImpl);
      attachments.push({ filename, content: pdf.toString('base64') });
    } catch (err) {
      // A reminder without the invoice is still worth sending, but the message
      // promises an attachment, so say so rather than sending a lie.
      throw new ValidationError(
        `Could not fetch the invoice PDF from QuickBooks to attach: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        reply_to: env.BOM_REPLY_TO,
        to: recipients,
        ...(input.cc
          ? {
              cc: input.cc
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
        ...(env.BOM_BCC_EMAIL ? { bcc: [env.BOM_BCC_EMAIL] } : {}),
        subject: input.subject.trim(),
        text: input.body,
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    ok = res.ok;
    if (!res.ok) error = `${res.status} ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Send failed';
  }

  // Logged either way: the reminder history is the record of how hard a balance
  // has been chased, and a silent failure would overstate it.
  const row = await prisma.paymentReminder.create({
    data: {
      qboTransactionId: txnId,
      organizationId: org?.id ?? null,
      toEmail: recipients.join(', '),
      ccEmail: input.cc?.trim() || null,
      subject: input.subject.trim(),
      body: input.body,
      balanceMinor: balance,
      currency: txn.currency,
      attachedInvoice: attachments.length > 0,
      status: ok ? 'sent' : 'failed',
      error,
      sentById: userId,
      sentByName: userName,
    },
  });

  await recordAudit({
    actorId: userId,
    action: ok ? 'qbo.reminder.sent' : 'qbo.reminder.send_failed',
    entity: 'QboTransaction',
    entityId: txnId,
    details: {
      to: recipients,
      balanceMinor: balance.toString(),
      docNumber: txn.qboDocNumber,
      error,
    },
  });

  if (!ok) {
    logger.warn({ err: error, txnId }, 'payment reminder: send failed');
    throw new ValidationError(`Could not send the reminder: ${error ?? 'unknown error'}`);
  }
  return { sent: true, to: recipients, reminderId: row.id };
}

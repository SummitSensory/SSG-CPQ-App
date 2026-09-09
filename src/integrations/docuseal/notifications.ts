import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { sendAlert } from '../../lib/alerts.js';
import { isMondayPushConfigured, env } from '../../config/env.js';
import { uploadFileToColumn } from '../monday/client.js';
import { dealItemIdFor } from '../monday/dealLink.js';
import { DEAL_COLUMNS } from '../monday/proposalPush.js';
import { getFile } from '../../lib/fileStore.js';
import {
  sendOutlookMail,
  OutlookNotConnectedError,
  OutlookSendNotGrantedError,
} from '../microsoft/graph.js';

/**
 * What happens after a signature request reaches a milestone.
 *
 * `applyStatus` (service.ts) is the single place that decides envelope status, and
 * it runs from both the DocuSeal webhook and the manual "Refresh status" sync — so
 * whatever it calls here must survive being asked twice for the same transition.
 * Each function below claims its own guard column with a conditional
 * `updateMany` before doing anything visible, so only the caller that actually
 * flips zero rows to one goes on to alert anyone or push to monday.
 *
 * Best-effort throughout: a failed alert or a failed monday push must not put the
 * envelope status itself in doubt, so nothing here throws back into applyStatus.
 */

/**
 * EsignEnvelope carries `proposalId` as a scalar, not a relation — there is no
 * `include: { proposal }` to reach for, so it is fetched alongside.
 */
export async function envelopeContext(envelopeId: string) {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    include: { signers: true },
  });
  if (!envelope) return null;
  const proposal = await prisma.proposal.findUnique({
    where: { id: envelope.proposalId },
    select: { id: true, number: true, title: true, organizationId: true, opportunityId: true },
  });
  if (!proposal) return null;
  return { ...envelope, proposal };
}

export type EnvelopeContext = NonNullable<Awaited<ReturnType<typeof envelopeContext>>>;

/**
 * Who gets the "viewed" / "still not signed" staff alerts. The sending rep sees
 * it themselves for the first 24 hours after send — long enough to be the
 * natural first responder to their own proposal — after which it escalates to
 * ESIGN_ESCALATION_EMAIL so a stalled deal keeps surfacing even if the original
 * rep is out or has moved on.
 */
async function escalationRecipient(envelope: {
  sentById: string | null;
  sentAt: Date | null;
}): Promise<string[]> {
  const withinFirstDay =
    envelope.sentAt != null && Date.now() - envelope.sentAt.getTime() < 24 * 60 * 60 * 1000;
  if (withinFirstDay && envelope.sentById) {
    const rep = await prisma.user.findUnique({
      where: { id: envelope.sentById },
      select: { email: true },
    });
    if (rep?.email) return [rep.email];
  }
  return [env.ESIGN_ESCALATION_EMAIL];
}

/**
 * The customer has signed and at least one required signer (in the normal flow,
 * Summit) has not. Tell staff there is a document waiting on them — the customer
 * cannot see this state in the app at all, so an email is the only prompt there is.
 */
export async function notifyCountersignNeeded(envelopeId: string): Promise<void> {
  const claimed = await prisma.esignEnvelope.updateMany({
    where: { id: envelopeId, countersignNotifiedAt: null },
    data: { countersignNotifiedAt: new Date() },
  });
  // A concurrent caller (webhook and a manual sync landing at once) already
  // claimed this — it is sending the one alert this transition gets.
  if (claimed.count === 0) return;

  const envelope = await envelopeContext(envelopeId);
  if (!envelope) return;
  const pending = envelope.signers.filter((s) => !s.viewOnly && s.status !== 'COMPLETED');
  if (!pending.length) return;

  sendAlert({
    title: `Proposal ${envelope.proposal.number} — customer signed, your signature is needed`,
    detail: [
      `${envelope.proposal.title || 'This proposal'} has been signed by the customer and is now waiting on: ` +
        pending.map((s) => `${s.name || s.role} (${s.email})`).join(', ') +
        '.',
      '',
      'Open the proposal in the CRM — the Electronic signature panel shows the countersigning link, or use the link DocuSeal emailed directly to the pending signer.',
    ].join('\n'),
    fingerprint: `esign-countersign-${envelopeId}`,
    context: { proposalNumber: envelope.proposal.number, envelopeId },
  });
}

/**
 * The customer just opened the proposal for the first time. Staff cannot see
 * this moment anywhere else in the app — this is the only way "know the minute
 * it was viewed, and by which address" reaches anyone. Fires once per envelope,
 * the first time any required signer's viewedAt is recorded (see the
 * `anyViewed && !envelope.viewedAt` guard in applyStatus, service.ts) — not
 * once per signer, so a multi-signer envelope does not alert repeatedly as each
 * party opens it.
 */
export async function notifyProposalViewed(envelopeId: string): Promise<void> {
  const claimed = await prisma.esignEnvelope.updateMany({
    where: { id: envelopeId, viewNotifiedAt: null },
    data: { viewNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const envelope = await envelopeContext(envelopeId);
  if (!envelope) return;
  const viewed = envelope.signers.filter((s) => !s.viewOnly && s.viewedAt);
  if (!viewed.length) return;

  const to = await escalationRecipient(envelope);
  sendAlert({
    to,
    title: `Proposal ${envelope.proposal.number} — the customer just opened it`,
    detail: [
      `${envelope.proposal.title || 'This proposal'} was viewed by:`,
      ...viewed.map((s) => `  ${s.name || s.role} (${s.email}) — ${s.viewedAt?.toISOString()}`),
      '',
      'Open the proposal in the CRM — the Electronic signature panel shows the full timeline.',
    ].join('\n'),
    fingerprint: `esign-viewed-${envelopeId}`,
    context: { proposalNumber: envelope.proposal.number, envelopeId },
  });
}

const CHASEABLE: Array<'SENT' | 'VIEWED' | 'PARTIALLY_SIGNED'> = [
  'SENT',
  'VIEWED',
  'PARTIALLY_SIGNED',
];
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daily "this proposal is still not signed" nudge to staff. Repeats every day,
 * with no cap, until the envelope leaves the chaseable set (signed, declined,
 * or voided) — a stalled deal should keep surfacing, not go quiet after some
 * fixed number of reminders.
 *
 * Meant to be called once a day from a cron route (see cronEsignReminders.ts) —
 * everything here is safe to run twice in the same day (guarded by
 * lastReminderSentAt) and safe to run late (it looks at elapsed time, not wall
 * clock).
 */
export async function sendEsignReminders(): Promise<{ reminded: number }> {
  const cutoff = new Date(Date.now() - REMINDER_INTERVAL_MS);
  const due = await prisma.esignEnvelope.findMany({
    where: {
      status: { in: CHASEABLE },
      sentAt: { not: null },
      OR: [{ lastReminderSentAt: null }, { lastReminderSentAt: { lt: cutoff } }],
    },
    select: { id: true, sentAt: true },
  });

  let reminded = 0;
  for (const row of due) {
    // sentAt itself must also predate the cutoff — a proposal sent an hour ago
    // has no lastReminderSentAt yet, but is not "due" for its first reminder
    // until it has been out a full day.
    if (!row.sentAt || row.sentAt > cutoff) continue;
    try {
      await remindOne(row.id);
      reminded += 1;
    } catch (err) {
      logger.error({ err, envelopeId: row.id }, 'esign: reminder failed');
    }
  }
  return { reminded };
}

async function remindOne(envelopeId: string): Promise<void> {
  const envelope = await envelopeContext(envelopeId);
  if (!envelope?.sentAt) return;
  const pending = envelope.signers.filter((s) => !s.viewOnly && s.status !== 'COMPLETED');
  if (!pending.length) return;

  await prisma.esignEnvelope.update({
    where: { id: envelopeId },
    data: { lastReminderSentAt: new Date() },
  });

  const to = await escalationRecipient(envelope);
  const ageDays = Math.max(
    1,
    Math.floor((Date.now() - envelope.sentAt.getTime()) / REMINDER_INTERVAL_MS),
  );
  sendAlert({
    to,
    title: `Proposal ${envelope.proposal.number} — still not signed after ${ageDays} day${ageDays === 1 ? '' : 's'}`,
    detail: [
      `${envelope.proposal.title || 'This proposal'} is still waiting on: ` +
        pending.map((s) => `${s.name || s.role} (${s.email})`).join(', ') +
        '.',
      '',
      'This reminder repeats daily until the proposal is signed, declined, or voided.',
    ].join('\n'),
    // Date-suffixed so the cron's daily run is not swallowed by sendAlert's own
    // 1-hour dedupe from a same-day retry, but a fresh day always gets through.
    fingerprint: `esign-reminder-${envelopeId}-${new Date().toISOString().slice(0, 10)}`,
    context: { proposalNumber: envelope.proposal.number, envelopeId },
  });
}

/**
 * A required signer declined. There is no path back from here in the app —
 * the customer cannot see this state either — so an email is the only way
 * staff learn a deal just stalled, and the only place declineReason (the
 * customer's own stated objection, when DocuSeal collected one) surfaces.
 */
export async function notifyProposalDeclined(envelopeId: string): Promise<void> {
  const claimed = await prisma.esignEnvelope.updateMany({
    where: { id: envelopeId, declineNotifiedAt: null },
    data: { declineNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const envelope = await envelopeContext(envelopeId);
  if (!envelope) return;
  const decliner = envelope.signers.find((s) => !s.viewOnly && s.status === 'DECLINED');

  const to = await escalationRecipient(envelope);
  sendAlert({
    to,
    title: `Proposal ${envelope.proposal.number} — declined`,
    detail: [
      `${envelope.proposal.title || 'This proposal'} was declined${decliner ? ` by ${decliner.name || decliner.role} (${decliner.email})` : ''}.`,
      envelope.declineReason ? `\nReason given: ${envelope.declineReason}` : '',
      '',
      'Open the proposal in the CRM — the Electronic signature panel shows the full timeline.',
    ].join('\n'),
    fingerprint: `esign-declined-${envelopeId}`,
    context: { proposalNumber: envelope.proposal.number, envelopeId },
  });
}

/**
 * Copy the executed PDF into the deal's "Signed Proposal" column on monday.com.
 * Mirrors uploadProposalPdfToMonday's shape — never throws, reports outcome as
 * data, and logs the attempt either way.
 */
export async function pushSignedProposalToMonday(
  envelope: EnvelopeContext,
): Promise<{ uploaded: boolean; skipped?: string; error?: string }> {
  if (!isMondayPushConfigured()) {
    return { uploaded: false, skipped: 'monday.com is not configured on this deployment.' };
  }
  if (!envelope.signedUrl) return { uploaded: false, skipped: 'no signed copy stored yet' };

  const { itemId, note } = await dealItemIdFor(
    envelope.proposal.organizationId,
    envelope.proposal.opportunityId,
  );
  if (!itemId) return { uploaded: false, skipped: note };

  try {
    const bytes = await getFile(envelope.signedUrl);
    await uploadFileToColumn(
      itemId,
      DEAL_COLUMNS.signedProposal,
      `${envelope.proposal.number}-signed.pdf`,
      bytes,
    );
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: 'EsignEnvelope',
        entityId: envelope.id,
        externalId: itemId,
        status: 'ok',
      },
    });
    return { uploaded: true };
  } catch (err) {
    logger.error(
      { err, envelopeId: envelope.id, itemId },
      'esign: signed-file push to monday failed',
    );
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: 'EsignEnvelope',
        entityId: envelope.id,
        externalId: itemId,
        status: 'error',
        error: String(err),
      },
    });
    return { uploaded: false, error: String(err) };
  }
}

/**
 * Both parties have signed. Push the executed document to the deal row and tell
 * staff to look at it — the whole reason storeSignedCopy runs is so there is
 * something to review by the time this alert lands.
 */
export async function notifyProposalCompleted(envelopeId: string): Promise<void> {
  const claimed = await prisma.esignEnvelope.updateMany({
    where: { id: envelopeId, completionNotifiedAt: null },
    data: { completionNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const envelope = await envelopeContext(envelopeId);
  if (!envelope) return;

  const push = await pushSignedProposalToMonday(envelope);

  sendAlert({
    title: `Proposal ${envelope.proposal.number} — fully signed, please review`,
    detail: [
      `${envelope.proposal.title || 'This proposal'} has now been signed by both the customer and Summit.`,
      push.uploaded
        ? 'The countersigned document has been uploaded to the deal’s Signed Proposal column on monday.com.'
        : push.skipped
          ? `It was not pushed to monday.com: ${push.skipped}`
          : `The monday.com push failed: ${push.error ?? 'unknown error'}. Check the integration sync log.`,
      '',
      'Open the proposal in the CRM and use "Download signed PDF" in the Electronic signature panel to review the executed document.',
    ].join('\n'),
    fingerprint: `esign-completed-${envelopeId}`,
    context: { proposalNumber: envelope.proposal.number, envelopeId },
  });
}

/**
 * Send the customer-facing "please review and sign" email — from the acting
 * rep's own connected Outlook mailbox, falling back to
 * ESIGN_EMAIL_FALLBACK_SENDER_EMAIL's mailbox when the rep has none. Returns the
 * id of whichever user's mailbox actually sent it, for emailSentFromUserId.
 */
async function sendEsignEmailTo(input: {
  actorId: string;
  to: { email: string; name?: string | null };
  subject: string;
  html: string;
}): Promise<string> {
  try {
    await sendOutlookMail({
      userId: input.actorId,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    });
    return input.actorId;
  } catch (err) {
    if (!(err instanceof OutlookNotConnectedError || err instanceof OutlookSendNotGrantedError)) {
      throw err;
    }
    const fallback = await prisma.user.findUnique({
      where: { email: env.ESIGN_EMAIL_FALLBACK_SENDER_EMAIL },
      select: { id: true },
    });
    // No fallback account, or the fallback IS the rep who just failed — surface
    // the original error rather than retrying the same failure.
    if (!fallback || fallback.id === input.actorId) throw err;
    await sendOutlookMail({
      userId: fallback.id,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    });
    return fallback.id;
  }
}

/**
 * Email whoever's turn it is right now: every view-only CC (no turn concept, they
 * are told about the request once, at send time) and the required signer(s) at
 * the lowest order that is still PENDING — the ones DocuSeal would have emailed
 * next had send_email been true.
 *
 * Idempotent via each signer's own `emailedAt` — safe to call from both the
 * initial send and every `applyStatus` run, which is what lets a signer's
 * completion unlock the next order tier's email without any status-transition
 * bookkeeping here.
 */
export async function notifyPendingSigners(envelopeId: string): Promise<void> {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    include: { signers: true },
  });
  if (!envelope || !envelope.sentById || !envelope.subject || !envelope.message) return;
  if (envelope.status === 'VOIDED' || envelope.status === 'FAILED' || envelope.status === 'DRAFT') {
    return;
  }

  const requiredPending = envelope.signers.filter(
    (s) => !s.viewOnly && s.status === 'PENDING' && !s.emailedAt,
  );
  const viewers = envelope.signers.filter((s) => s.viewOnly && !s.emailedAt);
  if (!requiredPending.length && !viewers.length) return;

  const minOrder = requiredPending.length ? Math.min(...requiredPending.map((s) => s.order)) : null;
  const due = [...requiredPending.filter((s) => s.order === minOrder), ...viewers];

  for (const signer of due) {
    // DocuSeal creates the submitter and its link synchronously with the
    // submission — this only trips if that response was somehow incomplete, in
    // which case the next sync/webhook retries with emailedAt still unset.
    if (!signer.signingUrl) continue;
    // A function replacer, not a string one — signingUrl is DocuSeal's, not
    // ours, and a string replacement would misread a literal `$&`/`$1`/etc. in
    // it as a regex replacement pattern instead of splicing it in verbatim.
    // Both spellings: `{{SigningLink}}` is current, `[Signing Link]` is what
    // an envelope sent before that format existed still has stored.
    const signingUrl = signer.signingUrl;
    const fillLink = (t: string) =>
      t
        .replace(/\{\{SigningLink\}\}/g, () => signingUrl)
        .replace(/\[Signing Link\]/g, () => signingUrl);
    const subject = fillLink(envelope.subject);
    const html = fillLink(envelope.message);
    try {
      const sentFromUserId = await sendEsignEmailTo({
        actorId: envelope.sentById,
        to: { email: signer.email, name: signer.name },
        subject,
        html,
      });
      await prisma.$transaction([
        prisma.esignSigner.update({ where: { id: signer.id }, data: { emailedAt: new Date() } }),
        prisma.esignEnvelope.update({
          where: { id: envelopeId },
          data: { emailSentFromUserId: sentFromUserId },
        }),
      ]);
    } catch (err) {
      logger.error(
        { err, envelopeId, signerId: signer.id },
        'esign: could not email signer their turn',
      );
    }
  }
}

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
async function envelopeContext(envelopeId: string) {
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

type EnvelopeContext = NonNullable<Awaited<ReturnType<typeof envelopeContext>>>;

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
 * Copy the executed PDF into the deal's "Signed Proposal" column on monday.com.
 * Mirrors uploadProposalPdfToMonday's shape — never throws, reports outcome as
 * data, and logs the attempt either way.
 */
async function pushSignedProposalToMonday(
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
    const subject = envelope.subject.replace(/\[Signing Link\]/g, signer.signingUrl);
    const html = envelope.message.replace(/\[Signing Link\]/g, signer.signingUrl);
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

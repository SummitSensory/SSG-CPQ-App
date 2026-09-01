import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { renderPdf, pdfAvailable } from '../../render/pdf.js';
import { versionTotals, type RawItem } from '../../proposals/analytics.js';
import { env, isDocusealConfigured } from '../../config/env.js';
import {
  archiveSubmission,
  createSubmission,
  createTemplateFromPdf,
  fetchCompletedPdf,
  getSubmission,
  type DocusealSubmitter,
} from './client.js';
import { buildPackageHtml, type AssemblyAttachment, type SignerSpec } from './assembly.js';
import { envelopePath, putPdf } from './storage.js';
import { appendPdfDocuments } from '../../lib/pdfMerge.js';
import { resolveReferenceDocuments } from '../../proposals/referenceDocuments.js';

/**
 * Proposal e-signing.
 *
 * The rules this module holds to, because each one was a decision:
 *
 *   - **Assembly happens here.** The package is composed and rendered before
 *     DocuSeal is called, so what a customer signs is the document the CRM
 *     produced. See assembly.ts.
 *   - **A send creates a new envelope.** Nothing edits which document a customer
 *     was asked to sign; a corrected proposal is a new envelope and the old one is
 *     voided explicitly.
 *   - **Only one envelope is live per proposal version.** Two open signing links
 *     for the same job is how a customer signs the wrong price.
 *   - **Webhooks are the source of truth, polling is the backstop.** Both funnel
 *     through `applyStatus`, so a missed webhook and a manual refresh cannot
 *     disagree.
 */

const LIVE: Array<'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIALLY_SIGNED'> = [
  'DRAFT',
  'SENT',
  'VIEWED',
  'PARTIALLY_SIGNED',
];

export const SUMMIT_ROLE = 'Summit';
export const CUSTOMER_ROLE = 'Customer';

/* -------------------------------------------------------------------------- */
/* Template resolution                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Which of the signing templates this proposal should use.
 *
 * Automatic from the product lines on the version, with a manual override: the rep
 * passes `templateKey` and it wins, no questions asked. Specificity beats
 * generality — a template naming this proposal's product line is chosen over the
 * catch-all, and a template naming no lines at all is the fallback.
 *
 * Ties are broken by `sortOrder` then `key`, so the choice is stable rather than
 * whatever the database returned first.
 */
export async function resolveProposalTemplate(input: {
  items: unknown;
  templateKey?: string;
}): Promise<{ id: string; key: string; name: string; bodyHtml: string } | null> {
  if (input.templateKey) {
    const picked = await prisma.esignDocumentTemplate.findUnique({
      where: { key: input.templateKey },
    });
    if (!picked)
      throw new ValidationError(`No signing template with the key “${input.templateKey}”.`);
    if (!picked.active)
      throw new ValidationError(`The signing template “${picked.name}” is switched off.`);
    return picked;
  }

  const lineIds = await productLineIdsFor(input.items);
  const candidates = await prisma.esignDocumentTemplate.findMany({
    where: { kind: 'PROPOSAL', active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  if (!candidates.length) return null;

  const specific = candidates.find((t) => t.productLineIds.some((id) => lineIds.has(id)));
  return specific ?? candidates.find((t) => t.productLineIds.length === 0) ?? candidates[0]!;
}

/** Product lines represented on a version, read through the products it prices. */
async function productLineIdsFor(items: unknown): Promise<Set<string>> {
  const ids = Array.isArray(items)
    ? (items as RawItem[]).map((i) => i?.productId).filter((v): v is string => Boolean(v))
    : [];
  if (!ids.length) return new Set();
  const products = await prisma.product.findMany({
    where: { id: { in: Array.from(new Set(ids)) } },
    select: { productLineId: true },
  });
  return new Set(products.map((p) => p.productLineId).filter((v): v is string => Boolean(v)));
}

/**
 * Attachment documents to bind behind the proposal.
 *
 * The conditions are not decided yet — which of liability, financing and the mat
 * specification pages ride along, and on what trigger, is an open question. Until
 * it is answered this reads exactly two things: an explicit list from the caller,
 * and `attachRule.always === true` on a template. Anything else in `attachRule` is
 * stored and ignored, so the rules can be written in the database ahead of the code
 * that reads them.
 */
export async function resolveAttachments(input: {
  keys?: string[];
}): Promise<AssemblyAttachment[]> {
  const templates = await prisma.esignDocumentTemplate.findMany({
    where: { kind: 'ATTACHMENT', active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  const wanted = new Set(input.keys ?? []);
  const chosen = templates.filter((t) => {
    if (wanted.has(t.key)) return true;
    const rule = (t.attachRule ?? {}) as { always?: boolean };
    return rule.always === true;
  });
  const missing = Array.from(wanted).filter((k) => !templates.some((t) => t.key === k));
  if (missing.length) {
    throw new ValidationError(`No active attachment template for: ${missing.join(', ')}.`);
  }
  return chosen.map((t) => ({ key: t.key, name: t.name, bodyHtml: t.bodyHtml }));
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

export interface SendInput {
  versionId: string;
  /** The document the browser rendered — same markup as the preview and the email. */
  proposalHtml: string;
  signers: SignerSpec[];
  templateKey?: string;
  attachmentKeys?: string[];
  /**
   * ReferenceDocument keys to merge in as trailing PDF pages — a W9, a certificate of
   * insurance. Explicit from the caller, the same as attachmentKeys, rather than read
   * from the proposal's saved builder meta the way the monday push reads them: this is
   * itself the one "compose what goes out" step for a signature request, so there is
   * no separate save this could drift from.
   */
  referenceDocumentKeys?: string[];
  subject?: string;
  message?: string;
  filename?: string;
  actorId: string;
}

export interface SendResult {
  envelopeId: string;
  status: string;
  submissionId?: string;
  signers: Array<{ role: string; email: string; signingUrl?: string | null }>;
  packageUrl?: string | null;
  packageSha256?: string;
}

export async function sendProposalForSignature(input: SendInput): Promise<SendResult> {
  if (!isDocusealConfigured()) {
    throw new ValidationError(
      'E-signing is not configured on this deployment — set DOCUSEAL_API_TOKEN.',
    );
  }
  if (!(await pdfAvailable())) {
    throw new ValidationError('PDF rendering is not available on this deployment.');
  }
  if (!input.proposalHtml?.trim()) {
    throw new ValidationError('The rendered proposal is missing from the request.');
  }
  if (!input.signers?.length) throw new ValidationError('Add at least one signer.');
  for (const s of input.signers) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email ?? '')) {
      throw new ValidationError(`“${s.email ?? ''}” is not a valid email address.`);
    }
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true,
      status: true,
      items: true,
      sections: true,
      proposal: { select: { id: true, number: true, title: true, organizationId: true } },
    },
  });
  if (!version?.proposal) throw new NotFoundError('Proposal version not found');

  // A draft is still being edited; sending it for signature would put a price in
  // front of a customer that nobody has reviewed.
  if (version.status === 'DRAFT') {
    throw new ValidationError('Release the proposal before sending it for signature.');
  }

  const open = await prisma.esignEnvelope.findFirst({
    where: { versionId: input.versionId, status: { in: LIVE } },
    select: { id: true, status: true },
  });
  if (open) {
    throw new ValidationError(
      'This proposal version already has a signature request out. Void it before sending another.',
    );
  }

  const org = await prisma.organization.findUnique({
    where: { id: version.proposal.organizationId },
    select: { name: true },
  });
  const totals = versionTotals(version.items, version.sections);

  const template = await resolveProposalTemplate({
    items: version.items,
    templateKey: input.templateKey,
  });
  const attachments = await resolveAttachments({ keys: input.attachmentKeys });

  // Signers are ordered so the customer signs first and we countersign after —
  // countersigning a document the customer has not signed is backwards.
  const signers = input.signers.map((s, i) => ({ ...s, order: s.order ?? i + 1 }));

  const html = buildPackageHtml({
    proposalHtml: input.proposalHtml,
    attachments,
    signers,
    proposalNumber: version.proposal.number,
    proposalTitle: version.proposal.title,
    customerName: org?.name,
    totalMinor: totals.total,
  });

  let pdf = await renderPdf(html, { format: 'Letter' });
  const referenceDocs = await resolveReferenceDocuments(input.referenceDocumentKeys ?? []);
  // Merged in before the hash is taken, so packageSha256 answers for the document as
  // it actually went out — pages and all — not just the HTML half of it.
  if (referenceDocs.length) pdf = await appendPdfDocuments(pdf, referenceDocs);
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const name = (input.filename || version.proposal.number).replace(/\.pdf$/i, '');

  // The envelope row exists before DocuSeal is called, so a failed send leaves a
  // record of the attempt with the document that was going to go out.
  const envelope = await prisma.esignEnvelope.create({
    data: {
      proposalId: version.proposal.id,
      versionId: version.id,
      templateId: template?.id ?? null,
      templateKey: template?.key ?? null,
      attachments: attachments.map((a) => a.key) as Prisma.InputJsonValue,
      referenceDocuments: (input.referenceDocumentKeys ?? []) as Prisma.InputJsonValue,
      status: 'DRAFT',
      subject: input.subject ?? null,
      message: input.message ?? null,
      packageSha256: sha256,
      packageBytes: pdf.length,
      sentById: input.actorId,
      signers: {
        create: signers.map((s) => ({
          role: s.role,
          name: s.name ?? null,
          email: s.email,
          order: s.order ?? 1,
        })),
      },
    },
    include: { signers: true },
  });

  const stored = await putPdf(
    envelopePath({
      proposalNumber: version.proposal.number,
      envelopeId: envelope.id,
      kind: 'package',
    }),
    pdf,
  );

  try {
    const docTemplate = await createTemplateFromPdf({
      name: `${version.proposal.number} — ${version.proposal.title || 'Proposal'}`,
      filename: `${name}.pdf`,
      pdf,
      folderName: env.DOCUSEAL_FOLDER || undefined,
    });

    const submitters = await createSubmission({
      templateId: docTemplate.id,
      sendEmail: env.DOCUSEAL_SEND_EMAIL,
      message:
        input.subject || input.message
          ? { subject: input.subject, body: input.message }
          : undefined,
      submitters: signers.map((s) => ({
        role: s.role,
        email: s.email,
        name: s.name,
        order: s.order,
      })),
    });

    const updated = await prisma.$transaction(async (tx) => {
      for (const row of envelope.signers) {
        const match = submitters.find(
          (sub) =>
            (sub.role && sub.role === row.role) ||
            sub.email?.toLowerCase() === row.email.toLowerCase(),
        );
        if (!match) continue;
        await tx.esignSigner.update({
          where: { id: row.id },
          data: {
            docusealSubmitterId: String(match.id),
            signingUrl: match.embed_src ?? (match.slug ? signingUrlFor(match.slug) : null),
          },
        });
      }
      return tx.esignEnvelope.update({
        where: { id: envelope.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          docusealTemplateId: String(docTemplate.id),
          docusealSubmissionId: submitters[0]?.submission_id
            ? String(submitters[0].submission_id)
            : null,
          packageUrl: stored?.url ?? null,
        },
        include: { signers: true },
      });
    });

    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: 'EsignEnvelope',
        entityId: envelope.id,
        externalId: updated.docusealSubmissionId,
        status: 'ok',
      },
    });
    await recordAudit({
      actorId: input.actorId,
      action: 'esign.sent',
      entity: 'ProposalVersion',
      entityId: version.id,
      details: {
        envelopeId: envelope.id,
        templateKey: template?.key ?? null,
        attachments: attachments.map((a) => a.key),
        signers: signers.map((s) => s.email),
        sha256,
      },
    });

    logger.info(
      { envelopeId: envelope.id, submissionId: updated.docusealSubmissionId },
      'esign: sent',
    );
    return {
      envelopeId: envelope.id,
      status: updated.status,
      submissionId: updated.docusealSubmissionId ?? undefined,
      signers: updated.signers.map((s) => ({
        role: s.role,
        email: s.email,
        signingUrl: s.signingUrl,
      })),
      packageUrl: stored?.url ?? null,
      packageSha256: sha256,
    };
  } catch (err) {
    await prisma.esignEnvelope.update({
      where: { id: envelope.id },
      data: { status: 'FAILED', error: String(err), packageUrl: stored?.url ?? null },
    });
    await prisma.integrationSyncLog.create({
      data: {
        direction: 'OUTBOUND',
        entity: 'EsignEnvelope',
        entityId: envelope.id,
        status: 'error',
        error: String(err),
      },
    });
    logger.error({ err, envelopeId: envelope.id }, 'esign: send failed');
    throw new ValidationError(
      `The signature request could not be created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function signingUrlFor(slug: string): string {
  const base = (env.DOCUSEAL_SIGNING_BASE_URL ?? 'https://docuseal.com').replace(/\/+$/, '');
  return `${base}/s/${slug}`;
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

const SIGNER_STATUS: Record<string, 'PENDING' | 'VIEWED' | 'COMPLETED' | 'DECLINED'> = {
  sent: 'PENDING',
  awaiting: 'PENDING',
  pending: 'PENDING',
  opened: 'VIEWED',
  viewed: 'VIEWED',
  completed: 'COMPLETED',
  declined: 'DECLINED',
};

/**
 * Fold DocuSeal's submitter list into our envelope. The single place that decides
 * envelope status, so a webhook and a poll cannot reach different conclusions from
 * the same facts.
 */
export async function applyStatus(
  envelopeId: string,
  submitters: DocusealSubmitter[],
): Promise<void> {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    include: { signers: true },
  });
  if (!envelope) return;
  // A voided envelope stays voided. Late events about a document we withdrew must
  // not resurrect it.
  if (envelope.status === 'VOIDED') return;

  for (const sub of submitters) {
    const row =
      envelope.signers.find((s) => s.docusealSubmitterId === String(sub.id)) ??
      envelope.signers.find((s) => s.email.toLowerCase() === (sub.email ?? '').toLowerCase());
    if (!row) continue;
    const status = SIGNER_STATUS[(sub.status ?? '').toLowerCase()] ?? row.status;
    await prisma.esignSigner.update({
      where: { id: row.id },
      data: {
        status,
        docusealSubmitterId: row.docusealSubmitterId ?? String(sub.id),
        ...(sub.opened_at ? { viewedAt: new Date(sub.opened_at) } : {}),
        ...(sub.completed_at ? { completedAt: new Date(sub.completed_at) } : {}),
        ...(sub.embed_src && !row.signingUrl ? { signingUrl: sub.embed_src } : {}),
      },
    });
  }

  const signers = await prisma.esignSigner.findMany({ where: { envelopeId } });
  const declined = signers.find((s) => s.status === 'DECLINED');
  const completed = signers.length > 0 && signers.every((s) => s.status === 'COMPLETED');
  const anyCompleted = signers.some((s) => s.status === 'COMPLETED');
  const anyViewed = signers.some((s) => s.status === 'VIEWED' || s.viewedAt);

  const next = declined
    ? 'DECLINED'
    : completed
      ? 'COMPLETED'
      : anyCompleted
        ? 'PARTIALLY_SIGNED'
        : anyViewed
          ? 'VIEWED'
          : envelope.status;

  const now = new Date();
  await prisma.esignEnvelope.update({
    where: { id: envelopeId },
    data: {
      status: next,
      ...(anyViewed && !envelope.viewedAt ? { viewedAt: now } : {}),
      ...(next === 'COMPLETED' && !envelope.completedAt ? { completedAt: now } : {}),
      ...(next === 'DECLINED' && !envelope.declinedAt
        ? { declinedAt: now, declineReason: declined?.declineReason ?? null }
        : {}),
    },
  });

  if (next === 'COMPLETED' && !envelope.signedUrl) await storeSignedCopy(envelopeId);
}

/**
 * Copy the executed PDF into our own storage. Best effort by design — see the note
 * in storage.ts. The envelope is already COMPLETED; failing here would only hide
 * that fact.
 */
export async function storeSignedCopy(envelopeId: string): Promise<string | null> {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    select: { id: true, docusealSubmissionId: true, proposalId: true },
  });
  if (!envelope?.docusealSubmissionId) return null;
  const proposal = await prisma.proposal.findUnique({
    where: { id: envelope.proposalId },
    select: { number: true },
  });
  try {
    const doc = await fetchCompletedPdf(envelope.docusealSubmissionId);
    if (!doc) return null;
    const stored = await putPdf(
      envelopePath({
        proposalNumber: proposal?.number ?? 'proposal',
        envelopeId: envelope.id,
        kind: 'signed',
      }),
      doc.bytes,
    );
    const url = stored?.url ?? null;
    if (url)
      await prisma.esignEnvelope.update({ where: { id: envelope.id }, data: { signedUrl: url } });
    return url;
  } catch (err) {
    logger.error({ err, envelopeId }, 'esign: storing the signed copy failed');
    return null;
  }
}

/** Ask DocuSeal where the envelope stands. The backstop for a missed webhook. */
export async function syncEnvelope(envelopeId: string): Promise<{ status: string }> {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    select: { id: true, docusealSubmissionId: true, status: true },
  });
  if (!envelope) throw new NotFoundError('Signature request not found');
  if (!envelope.docusealSubmissionId) return { status: envelope.status };

  const submission = await getSubmission(envelope.docusealSubmissionId);
  await applyStatus(envelope.id, submission.submitters ?? []);
  const after = await prisma.esignEnvelope.findUnique({
    where: { id: envelope.id },
    select: { status: true },
  });
  return { status: after?.status ?? envelope.status };
}

/**
 * Withdraw a signature request.
 *
 * Archived at DocuSeal so the links stop working, then marked here with who did it
 * and why. A completed envelope cannot be voided: the document is signed, and the
 * record of that is not ours to erase.
 */
export async function voidEnvelope(input: {
  envelopeId: string;
  reason?: string;
  actorId: string;
}): Promise<{ status: string }> {
  const envelope = await prisma.esignEnvelope.findUnique({ where: { id: input.envelopeId } });
  if (!envelope) throw new NotFoundError('Signature request not found');
  if (envelope.status === 'COMPLETED') {
    throw new ValidationError('This proposal has already been signed — it cannot be withdrawn.');
  }
  if (envelope.status === 'VOIDED') return { status: 'VOIDED' };

  if (envelope.docusealSubmissionId) {
    await archiveSubmission(envelope.docusealSubmissionId).catch((err: unknown) => {
      // Report it, do not stop: the point of voiding is that our side refuses the
      // envelope, and an unreachable DocuSeal must not leave it looking live here.
      logger.warn({ err, envelopeId: envelope.id }, 'esign: archiving the submission failed');
    });
  }

  await prisma.esignEnvelope.update({
    where: { id: envelope.id },
    data: {
      status: 'VOIDED',
      voidedAt: new Date(),
      voidedById: input.actorId,
      declineReason: input.reason ?? null,
    },
  });
  await recordAudit({
    actorId: input.actorId,
    action: 'esign.voided',
    entity: 'ProposalVersion',
    entityId: envelope.versionId,
    details: { envelopeId: envelope.id, reason: input.reason ?? null },
  });
  return { status: 'VOIDED' };
}

/** Append a provider event, ignoring a retry of one already recorded. */
export async function recordEvent(input: {
  envelopeId: string;
  eventType: string;
  raw: string;
  payload: unknown;
}): Promise<void> {
  const payloadHash = crypto.createHash('sha256').update(input.raw).digest('hex');
  await prisma.esignEvent
    .create({
      data: {
        envelopeId: input.envelopeId,
        eventType: input.eventType,
        payloadHash,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

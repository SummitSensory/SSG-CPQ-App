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
import {
  notifyCountersignNeeded,
  notifyProposalCompleted,
  notifyPendingSigners,
} from './notifications.js';
import { appendPdfDocuments, appendImagePages } from '../../lib/pdfMerge.js';
import { resolveReferenceDocuments } from '../../proposals/referenceDocuments.js';
import { resolveRenderings } from '../../lib/renderingStore.js';
import {
  renderEsignEmail,
  firstNameOf,
  type EsignEmailTemplateData,
} from '../../email/esignEmailTemplates.js';

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

/**
 * A rep's explicit "no, not even the auto-pick" — distinct from omitting
 * `emailTemplateKey`, which means "I have no preference, auto-pick for me".
 * Without this, a rep who deliberately deselects the auto-picked template in
 * the send form has no way to say so: an absent key and a rejected key look
 * identical to resolveEmailTemplate, and the rejection would silently be
 * overridden back to the very template it just declined.
 */
export const NO_EMAIL_TEMPLATE = '__none__';

/**
 * Which of the ~10 "please sign this" emails should go out with this proposal.
 *
 * Same rule as resolveProposalTemplate — auto-pick by product line, explicit
 * `emailTemplateKey` wins, empty-productLineIds is the fallback — but this is an
 * independent list: a rep can pair a Summit Flex document template with a
 * hand-picked email, or vice versa.
 */
export async function resolveEmailTemplate(input: {
  items: unknown;
  emailTemplateKey?: string;
}): Promise<(EsignEmailTemplateData & { id: string }) | null> {
  if (input.emailTemplateKey === NO_EMAIL_TEMPLATE) return null;
  if (input.emailTemplateKey) {
    const picked = await prisma.esignEmailTemplate.findUnique({
      where: { key: input.emailTemplateKey },
    });
    if (!picked)
      throw new ValidationError(`No signing email with the key “${input.emailTemplateKey}”.`);
    if (!picked.active)
      throw new ValidationError(`The signing email “${picked.name}” is switched off.`);
    return picked;
  }

  const lineIds = await productLineIdsFor(input.items);
  const candidates = await prisma.esignEmailTemplate.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  if (!candidates.length) return null;

  const specific = candidates.find((t) => t.productLineIds.some((id) => lineIds.has(id)));
  return specific ?? candidates.find((t) => t.productLineIds.length === 0) ?? candidates[0]!;
}

/** The customer's own first name for the email greeting — the first non-view-only
 *  signer with the Customer role, or just the first non-view-only signer. */
function firstNameOfContact(signers: SignerSpec[]): string {
  const primary =
    signers.find((s) => !s.viewOnly && s.role === CUSTOMER_ROLE) ??
    signers.find((s) => !s.viewOnly);
  return firstNameOf(primary?.name);
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
  /**
   * ProposalRendering ids to bind in as trailing pages — design renderings the
   * customer needs to see alongside what they're signing. In the order given,
   * which is what lets a rep change page order at send time rather than being
   * stuck with upload order. Land after the signature page and before reference
   * documents: central, job-specific content ahead of generic boilerplate forms.
   */
  renderingIds?: string[];
  emailTemplateKey?: string;
  /**
   * The rep's final wording for the "please sign this" email, as edited in the
   * send preview — defaults to the resolved template's own rendering when
   * omitted. Both may still contain the literal token `[Signing Link]`: it is
   * filled in per recipient, not here, because each signer gets their own
   * DocuSeal URL. See notifyPendingSigners in notifications.ts.
   */
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
  if (!input.signers.some((s) => !s.viewOnly)) {
    throw new ValidationError(
      'At least one signer has to actually sign — mark someone as a real signer, not just view only.',
    );
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

  const totals = versionTotals(version.items, version.sections);

  // None of these five reads depends on another's result — run them together
  // rather than paying for five sequential round trips on every send.
  const [org, template, attachments, emailTemplate, sender] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: version.proposal.organizationId },
      select: { name: true },
    }),
    resolveProposalTemplate({ items: version.items, templateKey: input.templateKey }),
    resolveAttachments({ keys: input.attachmentKeys }),
    resolveEmailTemplate({ items: version.items, emailTemplateKey: input.emailTemplateKey }),
    prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true } }),
  ]);
  // The rep's edit wins outright when given; otherwise the resolved template is
  // rendered here so an envelope always has a full email, even with no override
  // and no email template configured yet (falls back to a bare, functional note).
  // `[Signing Link]` is deliberately left in place — see notifyPendingSigners.
  const defaultEmail = emailTemplate
    ? renderEsignEmail(emailTemplate, {
        firstName: firstNameOfContact(input.signers),
        senderFirstName: firstNameOf(sender?.name),
        senderName: sender?.name ?? undefined,
        customerName: org?.name,
        proposalNumber: version.proposal.number,
        proposalTitle: version.proposal.title ?? undefined,
        signingLink: '[Signing Link]',
      })
    : {
        subject: `${version.proposal.number} — please review and sign`,
        html: `<p>Please review and sign the attached proposal.</p><p><a href="[Signing Link]">Review &amp; sign</a></p>`,
      };
  const emailSubject = input.subject?.trim() || defaultEmail.subject;
  const emailHtml = input.message?.trim() || defaultEmail.html;
  // The rep's edit is free-text HTML; the one thing it cannot lose is the one
  // thing that makes the email functional. Checked here, not just in the send
  // modal, because the modal's check is not the only path to this function.
  if (!emailHtml.includes('[Signing Link]')) {
    throw new ValidationError(
      'The email body no longer has a [Signing Link] placeholder — the recipient would have no way to open the document. Add it back (e.g. in a link) before sending.',
    );
  }

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
  // Renderings first — central, job-specific content — then reference documents,
  // which are generic boilerplate forms. Each rendering is merged individually,
  // in the order given, rather than as two batched passes (all PDFs, then all
  // images): a batched pass would silently reorder a mixed PDF/image selection.
  const renderings = await resolveRenderings(version.proposal.id, input.renderingIds ?? []);
  for (const rendering of renderings) {
    pdf =
      rendering.contentType === 'application/pdf'
        ? await appendPdfDocuments(pdf, [rendering])
        : await appendImagePages(pdf, [rendering]);
  }
  // Only the ones that actually resolved and merged — resolveRenderings drops a
  // rendering that failed to fetch, and the audit trail should answer for what
  // actually went out, not what was asked for.
  const mergedRenderingIds = renderings.map((r) => r.id);
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
      emailTemplateId: emailTemplate?.id ?? null,
      emailTemplateKey: emailTemplate?.key ?? null,
      attachments: attachments.map((a) => a.key) as Prisma.InputJsonValue,
      referenceDocuments: (input.referenceDocumentKeys ?? []) as Prisma.InputJsonValue,
      renderings: mergedRenderingIds as Prisma.InputJsonValue,
      status: 'DRAFT',
      subject: emailSubject,
      message: emailHtml,
      packageSha256: sha256,
      packageBytes: pdf.length,
      sentById: input.actorId,
      signers: {
        create: signers.map((s) => ({
          role: s.role,
          name: s.name ?? null,
          email: s.email,
          order: s.order ?? 1,
          viewOnly: s.viewOnly ?? false,
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

    // DocuSeal never emails anyone — the CRM does, from the rep's own mailbox, once
    // the submission (and each signer's signingUrl) exists. See
    // notifyPendingSigners below.
    const submitters = await createSubmission({
      templateId: docTemplate.id,
      sendEmail: false,
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
        renderings: mergedRenderingIds,
        signers: signers.map((s) => s.email),
        sha256,
      },
    });

    logger.info(
      { envelopeId: envelope.id, submissionId: updated.docusealSubmissionId },
      'esign: sent',
    );
    // Emails whoever's turn it is right now — the first signer(s) in order, and
    // every view-only CC. Best-effort: a failed email must not undo a send that
    // DocuSeal already has, and "Refresh status" or the next webhook retries it
    // (emailedAt is unset, so it is still due).
    await notifyPendingSigners(envelope.id).catch((err) =>
      logger.error({ err, envelopeId: envelope.id }, 'esign: initial signer email failed'),
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
  // Envelope status answers "has everyone who needs to SIGN done so" — a CC
  // viewer has nothing to sign or decline, so one who never opens the document
  // (or, per DocuSeal, could not meaningfully "decline" it) must never be why
  // an otherwise-complete envelope sits at PARTIALLY_SIGNED forever.
  const required = signers.filter((s) => !s.viewOnly);
  const declined = required.find((s) => s.status === 'DECLINED');
  const completed = required.length > 0 && required.every((s) => s.status === 'COMPLETED');
  const anyCompleted = required.some((s) => s.status === 'COMPLETED');
  const anyViewed = required.some((s) => s.status === 'VIEWED' || s.viewedAt);

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

  // Unconditional, unlike the two below: a signer completing their turn is what
  // makes the next order tier current, and notifyPendingSigners' own emailedAt
  // guard is what keeps this a no-op on every other status change.
  await notifyPendingSigners(envelopeId).catch((err) =>
    logger.error({ err, envelopeId }, 'esign: signer email failed'),
  );

  // Fired after the status write above, so a failed alert or monday push can
  // never leave the envelope's own status update in doubt.
  if (next === 'PARTIALLY_SIGNED' && envelope.status !== 'PARTIALLY_SIGNED') {
    await notifyCountersignNeeded(envelopeId).catch((err) =>
      logger.error({ err, envelopeId }, 'esign: countersign notification failed'),
    );
  }

  if (next === 'COMPLETED' && !envelope.signedUrl) await storeSignedCopy(envelopeId);
  if (next === 'COMPLETED') {
    await notifyProposalCompleted(envelopeId).catch((err) =>
      logger.error({ err, envelopeId }, 'esign: completion notification failed'),
    );
  }
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

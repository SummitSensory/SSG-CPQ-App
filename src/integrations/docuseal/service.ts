import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { ValidationError, NotFoundError } from '../../lib/errors.js';
import { renderPdf, pdfAvailable } from '../../render/pdf.js';
import { versionTotals, metaOf, type RawItem } from '../../proposals/analytics.js';
import { sellerCollectedCharges } from '../../crossborder/sellerCharges.js';
import { env, isDocusealConfigured } from '../../config/env.js';
import {
  archiveSubmission,
  createSubmission,
  createTemplateFromPdf,
  fetchCompletedPdf,
  getSubmission,
  type DocusealSubmitter,
} from './client.js';
import {
  buildPackage,
  CUSTOMER_ROLE,
  SUMMIT_ROLE,
  type AssemblyAttachment,
  type SignerSpec,
  type FieldSize,
} from './assembly.js';
import { getSavedFieldLayout } from './fieldLayoutStore.js';
// Re-exported: esign.ts and others import these role names from this module,
// but Customer/Summit are the document's own concept (assembly.ts decides
// which role's fields land where), not this file's.
export { CUSTOMER_ROLE, SUMMIT_ROLE };
import { envelopePath, putPdf } from './storage.js';
import {
  notifyCountersignNeeded,
  notifyProposalCompleted,
  notifyProposalDeclined,
  notifyProposalViewed,
  notifyPendingSigners,
  envelopeContext,
  pushSignedProposalToMonday,
} from './notifications.js';
import { sendAlert } from '../../lib/alerts.js';
import {
  appendPdfDocuments,
  appendImagePages,
  mergeRenderedPdfs,
  stampPageReferences,
} from '../../lib/pdfMerge.js';
import { resolveReferenceDocuments } from '../../proposals/referenceDocuments.js';
import { resolveRenderings } from '../../lib/renderingStore.js';
import { renderCertificatePdf, imageUrlToDataUri, type CertificateSigner } from './certificate.js';
import { resolveIpLocation } from '../geolocation.js';
import {
  renderEsignEmail,
  firstNameOf,
  lastNameOf,
  type EsignEmailTemplateData,
} from '../../email/esignEmailTemplates.js';
import { longDate } from '../../email/paymentTemplates.js';

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

/** The same signer firstNameOfContact resolves, split the other way. */
function lastNameOfContact(signers: SignerSpec[]): string {
  const primary =
    signers.find((s) => !s.viewOnly && s.role === CUSTOMER_ROLE) ??
    signers.find((s) => !s.viewOnly);
  return lastNameOf(primary?.name);
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
  /** For the {{LastName}} email placeholder — see EsignEmailContext. */
  lastName?: string;
  /** For the {{ProductName}} email placeholder — see EsignEmailContext. */
  productName?: string;
  /** For the {{ProductLine}} email placeholder — see EsignEmailContext. */
  productLine?: string;
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
  // resolveSignerRow and injectSignatureFields both assume role is unique per
  // required signer — "every envelope has exactly one Customer and one Summit
  // signer" per resolveSignerRow's own comment. A second required signer sharing
  // a role gets no field placed for them in the assembled PDF (injectSignatureFields
  // places one field per distinct role) and can have DocuSeal's submitter resolved
  // onto the wrong local row. Duplicate emails among required signers are the
  // same hazard from the other direction and are refused for the same reason.
  const requiredSigners = input.signers.filter((s) => !s.viewOnly);
  const seenRoles = new Set<string>();
  const seenEmails = new Set<string>();
  for (const s of requiredSigners) {
    const role = s.role.trim().toLowerCase();
    const email = (s.email ?? '').trim().toLowerCase();
    if (seenRoles.has(role)) {
      throw new ValidationError(
        `Two signers can't share the role "${s.role}" — give the second signer a distinct role.`,
      );
    }
    if (seenEmails.has(email)) {
      throw new ValidationError(`Two signers can't share the email address "${s.email}".`);
    }
    seenRoles.add(role);
    seenEmails.add(email);
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: input.versionId },
    select: {
      id: true,
      status: true,
      items: true,
      sections: true,
      version: true,
      expirationDate: true,
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

  // None of these seven reads depends on another's result — run them together
  // rather than paying for seven sequential round trips on every send.
  const [org, template, attachments, emailTemplate, sender, border, fieldLayout] =
    await Promise.all([
      prisma.organization.findUnique({
        where: { id: version.proposal.organizationId },
        select: { name: true },
      }),
      resolveProposalTemplate({ items: version.items, templateKey: input.templateKey }),
      resolveAttachments({ keys: input.attachmentKeys }),
      resolveEmailTemplate({ items: version.items, emailTemplateKey: input.emailTemplateKey }),
      prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true } }),
      sellerCollectedCharges(input.versionId),
      getSavedFieldLayout(),
    ]);
  // Only width/height/fontSize matter to the signed field — position is a purely
  // client-side cosmetic nudge on the blank line (see signatureFieldLayout.ts's own
  // comment on why the two are read in two different places).
  const fieldSizeOverrides: Record<string, Partial<FieldSize>> = {};
  for (const [id, saved] of Object.entries(fieldLayout)) {
    const { width, height, fontSize } = saved;
    if (width !== undefined || height !== undefined || fontSize !== undefined) {
      fieldSizeOverrides[id] = { width, height, fontSize };
    }
  }
  // What the customer actually owes, matching the figure the proposal document
  // itself prints as "Total payable to Summit" (see docTotal in
  // proposal-document.js) — versionTotals() alone is the pre-cross-border figure.
  // Signing a package that states a lower total than the document inside it would
  // be worse than not signing at all.
  const payableTotal = totals.total + border.totalMinor;
  // The rep's edit wins outright when given; otherwise the resolved template is
  // rendered here so an envelope always has a full email, even with no override
  // and no email template configured yet (falls back to a bare, functional note).
  // `{{SigningLink}}` is deliberately left in place — see notifyPendingSigners.
  const meta = metaOf(version.sections) as { proposalDate?: string };
  const defaultEmail = emailTemplate
    ? renderEsignEmail(emailTemplate, {
        firstName: firstNameOfContact(input.signers),
        lastName: input.lastName?.trim() || lastNameOfContact(input.signers) || undefined,
        senderFirstName: firstNameOf(sender?.name),
        senderName: sender?.name ?? undefined,
        customerName: org?.name,
        proposalNumber: version.proposal.number,
        proposalTitle: version.proposal.title ?? undefined,
        proposalVersionLabel: `V${version.version}`,
        proposalDateLabel: longDate(meta.proposalDate),
        proposalExpirationLabel: longDate(version.expirationDate),
        productName: input.productName?.trim() || undefined,
        productLine: input.productLine?.trim() || undefined,
        signingLink: '{{SigningLink}}',
      })
    : {
        subject: `${version.proposal.number} — please review and sign`,
        html: `<p>Please review and sign the attached proposal.</p><p><a href="{{SigningLink}}">Review &amp; sign</a></p>`,
      };
  const emailSubject = input.subject?.trim() || defaultEmail.subject;
  const emailHtml = input.message?.trim() || defaultEmail.html;
  // The rep's edit is free-text HTML; the one thing it cannot lose is the one
  // thing that makes the email functional. Checked here, not just in the send
  // modal, because the modal's check is not the only path to this function.
  // Both spellings accepted: `[Signing Link]` is the retired form, still
  // functional for a template saved before {{SigningLink}} existed.
  if (!emailHtml.includes('{{SigningLink}}') && !emailHtml.includes('[Signing Link]')) {
    throw new ValidationError(
      'The email body no longer has a {{SigningLink}} placeholder — the recipient would have no way to open the document. Add it back (e.g. in a link) before sending.',
    );
  }

  // Signers are ordered so the customer signs first and we countersign after —
  // countersigning a document the customer has not signed is backwards.
  const signers = input.signers.map((s, i) => ({ ...s, order: s.order ?? i + 1 }));

  const { proposalHtml, extraHtml } = buildPackage({
    proposalHtml: input.proposalHtml,
    attachments,
    signers,
    proposalNumber: version.proposal.number,
    proposalTitle: version.proposal.title,
    customerName: org?.name,
    totalMinor: payableTotal,
    fieldSizeOverrides,
  });

  // edgeToEdge: the proposal is fixed 8.5x11in sheets that already carry
  // their own margin as CSS padding — same rendering as the customer's own
  // copy (see proposalPush.ts / finance.ts). extraHtml (attachments and/or
  // the fallback signature page) is ordinary flowing content that needs
  // Chromium's own margin instead — one render pass cannot give both the
  // right margin at once, so it is a second render, merged on after. See
  // buildPackage's own comment in assembly.ts for the full story.
  //
  // The two renders have no dependency on each other, so they run
  // concurrently rather than one after the other — getBrowser() (render/pdf.ts)
  // already caches one browser instance and opens an independent page per
  // render. mergeRenderedPdfs, not appendPdfDocuments: a failure merging our
  // own two Chromium renders together should abort the send, not silently
  // drop the only page some signers get an actual field on (see its own
  // comment in lib/pdfMerge.ts).
  let pdf: Buffer;
  if (extraHtml) {
    const [proposalPdf, extraPdf] = await Promise.all([
      renderPdf(proposalHtml, { format: 'Letter', edgeToEdge: true }),
      renderPdf(extraHtml, { format: 'Letter' }),
    ]);
    pdf = await mergeRenderedPdfs(proposalPdf, extraPdf);
  } else {
    pdf = await renderPdf(proposalHtml, { format: 'Letter', edgeToEdge: true });
  }
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
      // resolveSignerRow, not a bespoke `role === row.role || email === row.email`
      // find — that OR, checked per row with no claimed set, let a submitter's EMAIL
      // match win over another submitter's correct ROLE match whenever two signers
      // share an email (this app's own Customer/Summit test setup does), assigning
      // the wrong docusealSubmitterId to each row from the very first send. That
      // wrong id then satisfied resolveSignerRow's own id-priority rule on every
      // later sync, permanently swapping the two signers' signature images on the
      // Certificate of Signature — see signatureImageFor's own comment for the
      // incident this caused on a real, completed envelope.
      const claimed = new Set<string>();
      for (const sub of submitters) {
        const row = resolveSignerRow(envelope.signers, claimed, sub);
        if (!row) continue;
        claimed.add(row.id);
        await tx.esignSigner.update({
          where: { id: row.id },
          data: {
            docusealSubmitterId: String(sub.id),
            signingUrl: sub.embed_src ?? (sub.slug ? signingUrlFor(sub.slug) : null),
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

/** The one local-row shape resolveSignerRow needs — a structural subset of
 *  EsignSigner, so it can be unit-tested with plain objects and no database. */
export interface SignerRowRef {
  id: string;
  role: string;
  email: string;
  docusealSubmitterId: string | null;
}

/**
 * Which local signer row one DocuSeal submitter belongs to, out of the rows this
 * same pass has not already claimed.
 *
 * `docusealSubmitterId` first (exact and authoritative once a previous pass has set
 * it correctly), then `role` (unique per envelope by construction — every envelope
 * has exactly one Customer and one Summit signer), then `email` last, because email
 * is the one key that is NOT guaranteed unique: the same person testing both roles,
 * or two roles at one company, share an email, and matching on it alone is exactly
 * what let two distinct DocuSeal submitters resolve to the same local row — see
 * applyStatus's own comment for the incident this fixed.
 */
export function resolveSignerRow<T extends SignerRowRef>(
  signers: readonly T[],
  claimed: ReadonlySet<string>,
  sub: Pick<DocusealSubmitter, 'id' | 'role' | 'email'>,
): T | undefined {
  return (
    signers.find((s) => !claimed.has(s.id) && s.docusealSubmitterId === String(sub.id)) ??
    signers.find((s) => !claimed.has(s.id) && sub.role && s.role === sub.role) ??
    signers.find(
      (s) => !claimed.has(s.id) && s.email.toLowerCase() === (sub.email ?? '').toLowerCase(),
    )
  );
}

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

  // Which local rows this pass has already resolved a DocuSeal submitter onto.
  // Without this, two submitters in the same `submitters` array could fold onto the
  // SAME row (see resolveSignerRow's own comment) — whichever this loop reaches
  // second would overwrite the first one's status/docusealSubmitterId, permanently
  // stranding the other real local row at whatever it last was, and an envelope
  // that can never satisfy "every required signer is COMPLETED" is an envelope
  // that can never leave PARTIALLY_SIGNED no matter how many times a rep clicks
  // "Refresh status".
  const claimed = new Set<string>();
  for (const sub of submitters) {
    const row = resolveSignerRow(envelope.signers, claimed, sub);
    if (!row) continue;
    claimed.add(row.id);
    const status = SIGNER_STATUS[(sub.status ?? '').toLowerCase()] ?? row.status;
    await prisma.esignSigner.update({
      where: { id: row.id },
      data: {
        status,
        docusealSubmitterId: String(sub.id),
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
  // never leave the envelope's own status update in doubt. Keyed on anyViewed
  // rather than `next === 'VIEWED'`, because a signer can go straight from
  // PENDING to COMPLETED without the envelope ever resting at VIEWED (next's own
  // ternary above prefers 'PARTIALLY_SIGNED'/'COMPLETED' over 'VIEWED' once any
  // signer has completed) — the same reasoning the viewedAt column itself uses.
  if (anyViewed && !envelope.viewedAt) {
    await notifyProposalViewed(envelopeId).catch((err) =>
      logger.error({ err, envelopeId }, 'esign: view notification failed'),
    );
  }

  if (next === 'PARTIALLY_SIGNED' && envelope.status !== 'PARTIALLY_SIGNED') {
    await notifyCountersignNeeded(envelopeId).catch((err) =>
      logger.error({ err, envelopeId }, 'esign: countersign notification failed'),
    );
  }

  if (next === 'DECLINED' && envelope.status !== 'DECLINED') {
    await notifyProposalDeclined(envelopeId).catch((err) =>
      logger.error({ err, envelopeId }, 'esign: decline notification failed'),
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
 *
 * This app's own branded "Certificate of Signature" page is appended after the
 * plain signed pages (see fetchCompletedPdf for why DocuSeal's own combined
 * document, with its own audit log baked in, is deliberately not used —
 * stacking both produced two audit/certificate pages in the stored copy).
 * Certificate rendering is best effort on its own: a failed render must not be
 * why the already-fetched signed pages fail to store.
 */
export async function storeSignedCopy(envelopeId: string): Promise<string | null> {
  const envelope = await prisma.esignEnvelope.findUnique({
    where: { id: envelopeId },
    include: { signers: { orderBy: { order: 'asc' } } },
  });
  if (!envelope?.docusealSubmissionId) return null;
  const proposal = await prisma.proposal.findUnique({
    where: { id: envelope.proposalId },
    select: { number: true, title: true, organizationId: true },
  });
  try {
    const doc = await fetchCompletedPdf(envelope.docusealSubmissionId);
    if (!doc) {
      // DocuSeal has not attached any signed document to the submission yet —
      // expected only in a very rare timing gap right after completion, not a
      // fault. Recorded (not just logged) so a copy that never arrives is
      // diagnosable from the envelope itself rather than only from the UI's
      // perpetual "Preparing…" message. See repairStuckSignedCopies for the
      // automatic retry.
      logger.info({ envelopeId }, 'esign: signed copy not ready yet, will retry');
      await prisma.esignEnvelope.update({
        where: { id: envelope.id },
        data: {
          signedCopyError: 'DocuSeal has not attached a signed document to the submission yet.',
        },
      });
      return null;
    }

    let bytes = doc.bytes;
    try {
      const org = proposal
        ? await prisma.organization.findUnique({
            where: { id: proposal.organizationId },
            select: { name: true },
          })
        : null;
      const signers = await enrichSignersForCertificate(envelope);
      const certificate = await renderCertificatePdf({
        envelopeId: envelope.id,
        proposalNumber: proposal?.number ?? 'proposal',
        proposalTitle: proposal?.title,
        customerName: org?.name,
        sentAt: envelope.sentAt,
        completedAt: envelope.completedAt,
        signers,
      });
      bytes = await appendPdfDocuments(bytes, [{ name: 'certificate', bytes: certificate }]);
    } catch (err) {
      logger.error({ err, envelopeId }, 'esign: certificate page render failed');
    }

    // Last step, after every merge above, so the stamp reaches every page —
    // the signed proposal, the certificate, and any attachment — regardless
    // of which renderer produced it. Best-effort like the certificate: a
    // stamping failure must not be why an otherwise-good signed copy fails
    // to store.
    try {
      bytes = await stampPageReferences(
        bytes,
        `${proposal?.number ?? 'proposal'} · Envelope ${envelope.docusealSubmissionId}`,
      );
    } catch (err) {
      logger.error({ err, envelopeId }, 'esign: page reference stamp failed');
    }

    const stored = await putPdf(
      envelopePath({
        proposalNumber: proposal?.number ?? 'proposal',
        envelopeId: envelope.id,
        kind: 'signed',
      }),
      bytes,
    );
    const url = stored?.url ?? null;
    if (url) {
      await prisma.esignEnvelope.update({
        where: { id: envelope.id },
        data: { signedUrl: url, signedCopyError: null },
      });
    } else {
      // putPdf is designed to never throw (see storage.ts) — a null return here
      // means Blob storage is unconfigured or rejected the upload, which would
      // otherwise be indistinguishable from "not ready yet" above.
      logger.error(
        { envelopeId },
        'esign: uploading the signed copy returned no URL (blob storage unavailable?)',
      );
      await prisma.esignEnvelope.update({
        where: { id: envelope.id },
        data: {
          signedCopyError:
            'Uploading the signed PDF to storage failed (check BLOB_READ_WRITE_TOKEN).',
        },
      });
    }
    return url;
  } catch (err) {
    logger.error({ err, envelopeId }, 'esign: storing the signed copy failed');
    await prisma.esignEnvelope
      .update({ where: { id: envelopeId }, data: { signedCopyError: String(err) } })
      .catch(() => {});
    return null;
  }
}

/**
 * Retry storing the signed copy — and the monday.com push that depends on it —
 * for every COMPLETED envelope still missing one. The backstop for
 * storeSignedCopy's "not ready yet" case never getting a second try because
 * nobody happened to click "Refresh status": meant to run daily from a cron
 * route (see cronEsignReminders.ts).
 */
export async function repairStuckSignedCopies(): Promise<{
  repaired: number;
  stillStuck: number;
}> {
  const stuck = await prisma.esignEnvelope.findMany({
    where: { status: 'COMPLETED', signedUrl: null },
    select: { id: true },
  });

  let repaired = 0;
  let stillStuck = 0;
  for (const { id } of stuck) {
    const url = await storeSignedCopy(id);
    const envelope = await envelopeContext(id);
    if (!envelope) continue;

    if (url) {
      repaired += 1;
      const push = await pushSignedProposalToMonday(envelope);
      sendAlert({
        title: `Proposal ${envelope.proposal.number} — signed copy recovered`,
        detail: [
          'The signed PDF that failed to store when this proposal completed has now been captured successfully.',
          push.uploaded
            ? 'It has been uploaded to the deal’s Signed Proposal column on monday.com.'
            : push.skipped
              ? `It was not pushed to monday.com: ${push.skipped}`
              : `The monday.com push failed: ${push.error ?? 'unknown error'}.`,
          '',
          'Open the proposal in the CRM and use "Download signed PDF" in the Electronic signature panel to review it.',
        ].join('\n'),
        fingerprint: `esign-repaired-${id}`,
        context: { proposalNumber: envelope.proposal.number, envelopeId: id },
      });
    } else {
      stillStuck += 1;
      sendAlert({
        title: `Proposal ${envelope.proposal.number} — signed copy still not captured`,
        detail: [
          `${envelope.proposal.title || 'This proposal'} completed signing but the certified copy still has not been stored.`,
          envelope.signedCopyError ? `Last error: ${envelope.signedCopyError}` : '',
          '',
          'This is retried automatically once a day. If it keeps failing, check DOCUSEAL_API_TOKEN / BLOB_READ_WRITE_TOKEN and the DocuSeal submission directly.',
        ]
          .filter(Boolean)
          .join('\n'),
        // Date-suffixed for the same reason as the reminder alert — a genuine
        // day-over-day recurrence must not be swallowed by the 1-hour dedupe.
        fingerprint: `esign-stuck-${id}-${new Date().toISOString().slice(0, 10)}`,
        context: { proposalNumber: envelope.proposal.number, envelopeId: id },
      });
    }
  }
  return { repaired, stillStuck };
}

/**
 * Builds each signer's certificate block at render time — nothing here is
 * persisted, and none of it is required: a submitter DocuSeal cannot be
 * matched to, or a lookup that fails, just means that signer's certificate
 * block shows less, never why the certificate (or the signed copy it rides
 * along with) fails to store. The drawn-signature image and resolved
 * location come from a fresh DocuSeal submission fetch; the IP address does
 * not (DocuSeal's REST response never carries it — see ipInfoFromEvents).
 */
async function enrichSignersForCertificate(envelope: {
  id: string;
  docusealSubmissionId: string | null;
  signers: Array<{
    id: string;
    role: string;
    name: string | null;
    email: string;
    viewOnly: boolean;
    status: string;
    emailedAt: Date | null;
    viewedAt: Date | null;
    completedAt: Date | null;
    declineReason: string | null;
    docusealSubmitterId: string | null;
  }>;
}): Promise<CertificateSigner[]> {
  let submitters: DocusealSubmitter[] = [];
  if (envelope.docusealSubmissionId) {
    try {
      const submission = await getSubmission(envelope.docusealSubmissionId);
      submitters = submission.submitters ?? [];
    } catch (err) {
      logger.warn(
        { err, envelopeId: envelope.id },
        'certificate: could not fetch fresh submitter detail from DocuSeal',
      );
    }
  }

  // Resolved the same unambiguous way applyStatus resolves a webhook's submitter
  // list — NOT a `.find()` per row with `id-match || email-match` as its own
  // condition, which is what let two submitters sharing an email (this app's own
  // test setup uses one address for both Customer and Summit) attach to the
  // wrong row: an OR checked separately for each candidate lets a WRONG
  // candidate's email match win over the RIGHT candidate's id match, if the
  // wrong one simply comes first in DocuSeal's own list order. See
  // resolveSignerRow's own comment for the incident this class of bug caused.
  const claimed = new Set<string>();
  const subForRowId = new Map<string, DocusealSubmitter>();
  for (const sub of submitters) {
    const row = resolveSignerRow(envelope.signers, claimed, sub);
    if (!row) continue;
    claimed.add(row.id);
    subForRowId.set(row.id, sub);
  }

  // DocuSeal's own "Get a submission" API — what `submitters` above came from —
  // has no `ip`/`ua` field on a submitter at all; those only ever exist in the
  // WEBHOOK payload for a form.viewed/started/completed/declined event (see
  // ipInfoFromEvents' own comment). `sub?.ip` here was always undefined for a
  // real submitter, which is why the certificate never showed an IP or
  // location for anyone, ever, regardless of geolocation.ts or IPINFO_TOKEN.
  const eventIp = await ipInfoFromEvents(envelope.id);

  return Promise.all(
    envelope.signers.map(async (row) => {
      const sub = subForRowId.get(row.id);
      const ipAddress = (row.docusealSubmitterId && eventIp.get(row.docusealSubmitterId)) || null;
      const [location, signatureDataUri] = await Promise.all([
        resolveIpLocation(ipAddress),
        signatureImageFor(sub, row.role),
      ]);
      return {
        role: row.role,
        name: row.name,
        email: row.email,
        viewOnly: row.viewOnly,
        status: row.status,
        emailedAt: row.emailedAt,
        viewedAt: row.viewedAt,
        completedAt: row.completedAt,
        declineReason: row.declineReason,
        ipAddress,
        location,
        signatureDataUri,
      };
    }),
  );
}

/**
 * The IP address each submitter signed from, keyed by their DocuSeal
 * submitter id — recovered from this envelope's own stored webhook events
 * (EsignEvent.payload, saved verbatim in esignWebhook.ts), the only place
 * DocuSeal's `ip` ever actually appears; see this function's caller for why
 * the REST "Get a submission" response can never supply it. Takes the most
 * recent event per submitter that actually carries an `ip`, which in
 * practice is whichever form.* event landed last for them.
 */
export async function ipInfoFromEvents(envelopeId: string): Promise<Map<string, string>> {
  const events = await prisma.esignEvent.findMany({
    where: { envelopeId },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  });
  const ipBySubmitterId = new Map<string, string>();
  for (const { payload } of events) {
    const data = (payload as { data?: { id?: number | string; ip?: string | null } } | null)?.data;
    const submitterId = data?.id !== undefined ? String(data.id) : null;
    // Events are ordered most-recent-first, and only the first ip seen per
    // submitter is kept — a later (older, since we're iterating in reverse)
    // event for the same submitter must not overwrite it.
    if (submitterId && data?.ip && !ipBySubmitterId.has(submitterId)) {
      ipBySubmitterId.set(submitterId, data.ip);
    }
  }
  return ipBySubmitterId;
}

/**
 * The first signature-type field value THIS ROLE actually filled. This app's
 * own text tags always name these "<Role> Signature" or "<Role> ...
 * Signature" (see assembly.ts's tag()) — matching only a trailing
 * "Signature" was not enough on its own: when two submitters share an email
 * (this app's own test setup uses one address for both Customer and
 * Summit), DocuSeal's own `values` array is not reliably scoped to only the
 * one submitter it is attached to, so a bare suffix match could pick up the
 * OTHER signer's drawn signature — which is exactly what put the customer's
 * signature under Summit's name on a real certificate. Requiring the field
 * name to also start with this signer's own role closes that regardless of
 * whether `values` is properly scoped.
 */
export async function signatureImageFor(
  sub: DocusealSubmitter | undefined,
  role: string,
): Promise<string | null> {
  // Exact match, not a prefix: fields are named "${role} Signature" (assembly.ts),
  // and a `startsWith` here previously matched "Witness" against a field actually
  // named "Witness2 Signature" — the same signer-swap failure mode fixed for exact
  // role collisions, reopened for role-is-a-prefix-of-another-role collisions.
  const wanted = `${role.trim().toLowerCase()} signature`;
  const value = sub?.values?.find((v) => v.field.trim().toLowerCase() === wanted)?.value;
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('data:image')) return value;
  if (/^https?:\/\//i.test(value)) return imageUrlToDataUri(value);
  return null;
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

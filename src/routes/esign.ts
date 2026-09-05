import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { isDocusealConfigured, env } from '../config/env.js';
import { isBlobConfigured } from '../integrations/docuseal/storage.js';
import { getFile } from '../lib/fileStore.js';
import {
  CUSTOMER_ROLE,
  resolveAttachments,
  resolveProposalTemplate,
  resolveEmailTemplate,
  sendProposalForSignature,
  syncEnvelope,
  voidEnvelope,
} from '../integrations/docuseal/service.js';
import {
  renderEsignEmail,
  firstNameOf,
  SAMPLE_ESIGN_EMAIL_CONTEXT,
  ESIGN_EMAIL_PLACEHOLDERS,
} from '../email/esignEmailTemplates.js';
import { longDate } from '../email/paymentTemplates.js';
import { metaOf } from '../proposals/analytics.js';
import { outlookStatusFor } from '../integrations/microsoft/graph.js';
import { pdfAvailable } from '../render/pdf.js';
import { checkDocumentTotal } from '../proposals/documentIntegrity.js';
import { enforceOrReport } from '../lib/guards.js';

/**
 * A nullable Json column does not take `null` — Prisma distinguishes clearing the
 * column (`DbNull`) from storing the JSON value `null` (`JsonNull`), so a plain
 * null is a type error. Clearing is what an absent rule means here. Same shape as
 * RuleCondition's `when` in routes/formulas.ts.
 */
const jsonOrClear = (v: Record<string, unknown> | null | undefined) =>
  v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

/**
 * Proposal e-signing.
 *
 * The send lives under `/render/*` on purpose: it renders the signing package with
 * headless Chromium, and per vercel.json that prefix is routed to its own function
 * with 3 GB and 180 seconds. On the main API function a cold browser either never
 * finishes or takes the request down with it — the same reason the monday document
 * upload was moved there.
 *
 * Everything else here is cheap and stays on the main function.
 */
const Signer = z.object({
  role: z.string().trim().min(1).max(40).default(CUSTOMER_ROLE),
  name: z.string().trim().max(160).optional(),
  email: z.string().trim().email(),
  order: z.number().int().min(1).max(10).optional(),
  titleField: z.boolean().optional(),
  /** A CC recipient, not a required signer — see EsignSigner.viewOnly. */
  viewOnly: z.boolean().optional(),
});

const SendBody = z.object({
  proposalHtml: z.string().min(1),
  signers: z.array(Signer).min(1).max(10),
  templateKey: z.string().trim().min(1).optional(),
  attachmentKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  referenceDocumentKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  renderingIds: z.array(z.string().trim().min(1)).max(50).optional(),
  emailTemplateKey: z.string().trim().min(1).optional(),
  /** The rep's final edit of the resolved email template — see SendInput. */
  subject: z.string().trim().max(300).optional(),
  message: z.string().max(20_000).optional(),
  filename: z.string().trim().max(160).optional(),
  /** The recipient's last name, for the {{LastName}} email placeholder. */
  lastName: z.string().trim().max(160).optional(),
  /** The proposed model/product, for the {{ProductName}} email placeholder. */
  productName: z.string().trim().max(200).optional(),
});

const TemplateBody = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, numbers and hyphens.'),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  kind: z.enum(['PROPOSAL', 'ATTACHMENT']).default('ATTACHMENT'),
  bodyHtml: z.string().min(1),
  productLineIds: z.array(z.string().trim().min(1)).max(50).optional(),
  attachRule: z.record(z.unknown()).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

const EmailTemplateBody = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, numbers and hyphens.'),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().min(1),
  productLineIds: z.array(z.string().trim().min(1)).max(50).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export function registerEsignRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const sign = { preHandler: requirePermission(Permission.PROPOSAL_ESIGN) };
  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  /**
   * What the UI needs to decide whether to offer the button at all, and whether
   * to warn the rep before they open the send form: the actual "please sign"
   * email now goes out from their own Outlook mailbox, not DocuSeal's, so a
   * missing connection is worth surfacing early rather than as a send-time error.
   */
  app.get('/esign/status', read, async (req) => ({
    configured: isDocusealConfigured(),
    pdf: await pdfAvailable(),
    storage: isBlobConfigured() ? 'blob' : 'docuseal',
    webhookConfigured: Boolean(env.DOCUSEAL_WEBHOOK_SECRET),
    outlook: await outlookStatusFor(req.user!.sub),
  }));

  /**
   * Send a released proposal for signature. `proposalHtml` is the document the
   * browser rendered, so the signed PDF and the customer's preview cannot drift.
   */
  app.post('/render/esign/proposals/versions/:versionId/send', sign, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    // What the customer signs must be what the proposal says. The HTML comes from the
    // rep's browser by design (the preview and the contract must not drift), which
    // means a stale tab or a crafted request could otherwise put a different bottom
    // line into a legally binding PDF. The server's own total has to appear in it.
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { items: true, sections: true },
    });
    if (!version) throw new NotFoundError('Proposal version not found');
    const check = checkDocumentTotal(parsed.data.proposalHtml, version.items, version.sections);
    if (!check.ok) {
      // Monitor mode by default. A wrongly-refused send stops a deal, so until the logs
      // confirm this only fires on a genuine mismatch it reports instead of refusing.
      enforceOrReport(
        'esign-document-total',
        { versionId, expected: check.expected, expectedMinor: check.expectedMinor },
        () =>
          new ValidationError(
            `This document does not match the saved proposal (its total should be ${check.expected}). Reload the proposal before sending it for signature.`,
          ),
      );
    }
    const result = await sendProposalForSignature({
      versionId,
      ...parsed.data,
      actorId: req.user!.sub,
    });
    return reply.status(201).send(result);
  });

  /**
   * What would be sent, without sending it: the resolved document template, the
   * attachments that would be bound in, and the resolved email — subject and
   * rendered HTML, ready to show in an editable preview. The rep sees every
   * auto-pick before committing to it, and can override each independently with
   * `templateKey` / `emailTemplateKey`.
   */
  app.get('/esign/proposals/versions/:versionId/plan', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const q = req.query as {
      templateKey?: string;
      attachmentKeys?: string;
      emailTemplateKey?: string;
      firstName?: string;
      lastName?: string;
      productName?: string;
    };
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        items: true,
        sections: true,
        version: true,
        expirationDate: true,
        proposal: { select: { number: true, title: true, organizationId: true } },
      },
    });
    if (!version?.proposal) throw new NotFoundError('Proposal version not found');
    const keys = q.attachmentKeys
      ? q.attachmentKeys
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
      : undefined;
    const template = await resolveProposalTemplate({
      items: version.items,
      templateKey: q.templateKey,
    });
    const attachments = await resolveAttachments({ keys });

    const emailTemplate = await resolveEmailTemplate({
      items: version.items,
      emailTemplateKey: q.emailTemplateKey,
    });
    let email: { key: string; name: string; subject: string; html: string } | null = null;
    if (emailTemplate) {
      const [org, sender] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: version.proposal.organizationId },
          select: { name: true },
        }),
        prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true } }),
      ]);
      const meta = metaOf(version.sections) as { proposalDate?: string };
      // `[Signing Link]` is left in place on purpose — no signing link exists
      // until the actual send creates the DocuSeal submission. It is filled in
      // per recipient at that point (see notifyPendingSigners).
      const rendered = renderEsignEmail(emailTemplate, {
        firstName: q.firstName?.trim() || 'there',
        lastName: q.lastName?.trim() || undefined,
        senderFirstName: firstNameOf(sender?.name),
        senderName: sender?.name ?? undefined,
        customerName: org?.name,
        proposalNumber: version.proposal.number,
        proposalTitle: version.proposal.title ?? undefined,
        proposalVersionLabel: `V${version.version}`,
        proposalDateLabel: longDate(meta.proposalDate),
        proposalExpirationLabel: longDate(version.expirationDate),
        productName: q.productName?.trim() || undefined,
        signingLink: '[Signing Link]',
      });
      email = {
        key: emailTemplate.key,
        name: emailTemplate.name,
        subject: rendered.subject,
        html: rendered.html,
      };
    }

    return {
      template: template ? { key: template.key, name: template.name } : null,
      attachments: attachments.map((a) => ({ key: a.key, name: a.name })),
      email,
    };
  });

  app.get('/esign/envelopes', read, async (req) => {
    const q = req.query as { proposalId?: string; versionId?: string; status?: string };
    return prisma.esignEnvelope.findMany({
      where: {
        ...(q.proposalId ? { proposalId: q.proposalId } : {}),
        ...(q.versionId ? { versionId: q.versionId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        signers: { orderBy: { order: 'asc' } },
      },
      take: 100,
    });
  });

  app.get('/esign/envelopes/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const envelope = await prisma.esignEnvelope.findUnique({
      where: { id },
      include: {
        signers: { orderBy: { order: 'asc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!envelope) throw new NotFoundError('Signature request not found');
    return envelope;
  });

  /** Re-read the envelope from DocuSeal. Manual backstop for a missed webhook. */
  app.post('/esign/envelopes/:id/sync', sign, async (req) => {
    const { id } = req.params as { id: string };
    return syncEnvelope(id);
  });

  app.post('/esign/envelopes/:id/void', sign, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return voidEnvelope({ envelopeId: id, reason: body.reason, actorId: req.user!.sub });
  });

  /**
   * The executed PDF, once fully signed. Proxied rather than redirected to the
   * blob URL — same reasoning as the reference-document download: the store is
   * private, and a browser needs the bearer token this route already holds.
   */
  app.get('/esign/envelopes/:id/signed-pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const envelope = await prisma.esignEnvelope.findUnique({
      where: { id },
      select: { signedUrl: true, proposalId: true },
    });
    if (!envelope) throw new NotFoundError('Signature request not found');
    if (!envelope.signedUrl)
      throw new ValidationError('This document has not been fully signed yet.');
    const proposal = await prisma.proposal.findUnique({
      where: { id: envelope.proposalId },
      select: { number: true },
    });
    const bytes = await getFile(envelope.signedUrl);
    return reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `inline; filename="${proposal?.number ?? 'proposal'}-signed.pdf"`,
      )
      .header('Cache-Control', 'private, max-age=60')
      .send(bytes);
  });

  /* ---- The ~10 signing document templates ---- */

  app.get('/esign/templates', read, async (req) => {
    const q = req.query as { kind?: string; includeInactive?: string };
    return prisma.esignDocumentTemplate.findMany({
      where: {
        ...(q.kind ? { kind: q.kind as never } : {}),
        ...(q.includeInactive === 'true' ? {} : { active: true }),
      },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { key: 'asc' }],
    });
  });

  app.post('/esign/templates', manage, async (req, reply) => {
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const existing = await prisma.esignDocumentTemplate.findUnique({
      where: { key: parsed.data.key },
    });
    if (existing)
      throw new ValidationError(`A template already uses the key “${parsed.data.key}”.`);
    const created = await prisma.esignDocumentTemplate.create({
      data: {
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        kind: parsed.data.kind,
        bodyHtml: parsed.data.bodyHtml,
        productLineIds: parsed.data.productLineIds ?? [],
        attachRule: jsonOrClear(parsed.data.attachRule),
        sortOrder: parsed.data.sortOrder ?? 0,
        active: parsed.data.active ?? true,
        createdById: req.user!.sub,
      },
    });
    return reply.status(201).send(created);
  });

  app.patch('/esign/templates/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = TemplateBody.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const existing = await prisma.esignDocumentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const d = parsed.data;
    return prisma.esignDocumentTemplate.update({
      where: { id },
      data: {
        ...(d.key ? { key: d.key } : {}),
        ...(d.name ? { name: d.name } : {}),
        ...(d.description !== undefined ? { description: d.description ?? null } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.bodyHtml ? { bodyHtml: d.bodyHtml } : {}),
        ...(d.productLineIds ? { productLineIds: d.productLineIds } : {}),
        ...(d.attachRule !== undefined ? { attachRule: jsonOrClear(d.attachRule) } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
      },
    });
  });

  /**
   * Templates are switched off rather than deleted — an envelope names the template
   * it was built from, and the record of what a customer signed must stay readable.
   */
  app.delete('/esign/templates/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.esignDocumentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    await prisma.esignDocumentTemplate.update({ where: { id }, data: { active: false } });
    return reply.status(204).send();
  });

  /* ---- The ~10 "please sign this" email templates ---- */

  app.get('/esign/email-templates', read, async (req) => {
    const q = req.query as { includeInactive?: string };
    return prisma.esignEmailTemplate.findMany({
      where: q.includeInactive === 'true' ? {} : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
  });

  /** Every template, rendered against a sample proposal — the admin editor's preview. */
  app.get('/esign/email-templates/preview', manage, async () => {
    const rows = await prisma.esignEmailTemplate.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    const usage = await prisma.esignEnvelope.groupBy({
      by: ['emailTemplateKey'],
      _count: { _all: true },
    });
    const countOf = new Map(usage.map((u) => [u.emailTemplateKey, u._count._all]));
    return {
      templates: rows.map((t) => ({
        ...t,
        sentCount: countOf.get(t.key) ?? 0,
        preview: renderEsignEmail(t, SAMPLE_ESIGN_EMAIL_CONTEXT),
      })),
      placeholders: ESIGN_EMAIL_PLACEHOLDERS,
    };
  });

  app.post('/esign/email-templates', manage, async (req, reply) => {
    const parsed = EmailTemplateBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const existing = await prisma.esignEmailTemplate.findUnique({
      where: { key: parsed.data.key },
    });
    if (existing)
      throw new ValidationError(`An email template already uses the key “${parsed.data.key}”.`);
    const created = await prisma.esignEmailTemplate.create({
      data: {
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        subject: parsed.data.subject,
        bodyHtml: parsed.data.bodyHtml,
        productLineIds: parsed.data.productLineIds ?? [],
        sortOrder: parsed.data.sortOrder ?? 0,
        active: parsed.data.active ?? true,
        createdById: req.user!.sub,
        updatedById: req.user!.sub,
      },
    });
    return reply.status(201).send(created);
  });

  app.patch('/esign/email-templates/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = EmailTemplateBody.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const existing = await prisma.esignEmailTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Email template not found');
    const d = parsed.data;
    // The key is what an envelope names as emailTemplateKey, so it is fixed once
    // this template has actually been sent — same rule as the document templates.
    if (d.key && d.key !== existing.key) {
      const used = await prisma.esignEnvelope.count({ where: { emailTemplateKey: existing.key } });
      if (used) {
        throw new ValidationError(
          `This email has been sent ${used} time${used === 1 ? '' : 's'}, so its key is fixed — the history refers to it. Change the name instead.`,
        );
      }
    }
    return prisma.esignEmailTemplate.update({
      where: { id },
      data: {
        ...(d.key ? { key: d.key } : {}),
        ...(d.name ? { name: d.name } : {}),
        ...(d.description !== undefined ? { description: d.description ?? null } : {}),
        ...(d.subject ? { subject: d.subject } : {}),
        ...(d.bodyHtml ? { bodyHtml: d.bodyHtml } : {}),
        ...(d.productLineIds ? { productLineIds: d.productLineIds } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        updatedById: req.user!.sub,
      },
    });
  });

  /**
   * Switched off rather than deleted — an envelope names the email template it
   * was built from, and the record of what a customer was actually sent must
   * stay readable.
   */
  app.delete('/esign/email-templates/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.esignEmailTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Email template not found');
    await prisma.esignEmailTemplate.update({ where: { id }, data: { active: false } });
    return reply.status(204).send();
  });
}

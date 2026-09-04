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
  sendProposalForSignature,
  syncEnvelope,
  voidEnvelope,
} from '../integrations/docuseal/service.js';
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
 * with 2 GB and 60 seconds. On the main API function a cold browser either never
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
});

const SendBody = z.object({
  proposalHtml: z.string().min(1),
  signers: z.array(Signer).min(1).max(10),
  templateKey: z.string().trim().min(1).optional(),
  attachmentKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  referenceDocumentKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  renderingIds: z.array(z.string().trim().min(1)).max(50).optional(),
  subject: z.string().trim().max(300).optional(),
  message: z.string().max(4000).optional(),
  filename: z.string().trim().max(160).optional(),
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

export function registerEsignRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const sign = { preHandler: requirePermission(Permission.PROPOSAL_ESIGN) };
  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  /** What the UI needs to decide whether to offer the button at all. */
  app.get('/esign/status', read, async () => ({
    configured: isDocusealConfigured(),
    pdf: await pdfAvailable(),
    storage: isBlobConfigured() ? 'blob' : 'docuseal',
    sendsProviderEmail: env.DOCUSEAL_SEND_EMAIL,
    webhookConfigured: Boolean(env.DOCUSEAL_WEBHOOK_SECRET),
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
   * What would be sent, without sending it: the resolved template and the
   * attachments that would be bound in. The rep sees the auto-pick before
   * committing to it, and can override with `templateKey`.
   */
  app.get('/esign/proposals/versions/:versionId/plan', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const q = req.query as { templateKey?: string; attachmentKeys?: string };
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { id: true, items: true },
    });
    if (!version) throw new NotFoundError('Proposal version not found');
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
    return {
      template: template ? { key: template.key, name: template.name } : null,
      attachments: attachments.map((a) => ({ key: a.key, name: a.name })),
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
}

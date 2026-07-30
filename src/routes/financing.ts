import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { quoteForProposal, loadFactors, FINANCE_SETTINGS } from '../proposals/financing.js';
import { renderFinancingHtml } from '../proposals/financingDocument.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';

/**
 * Ryan Capital financing: the quote, the document, and sending it on.
 *
 * The whole sheet is derived from the proposal total, so there is no "create a
 * financing document" step — asking for it computes it.
 */

const FactorSchema = z.object({
  termMonths: z.number().int().min(1).max(240),
  /** Payment per $1 financed. Small by nature — 0.0327 is a 36-month factor. */
  factor: z.number().min(0.0001).max(1),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const SendSchema = z.object({
  to: z.string().trim().email().optional(),
  cc: z.string().trim().max(400).optional(),
  message: z.string().max(8000).optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerFinancingRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  /** The computed quote for a proposal — drives the on-screen preview. */
  app.get('/proposals/:id/financing', read, async (req) => {
    const { id } = req.params as { id: string };
    return quoteForProposal(id);
  });

  /** The document as HTML, for the in-app preview and the browser print path. */
  app.get('/proposals/:id/financing.html', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { html } = await renderFinancingHtml(id);
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  app.get('/render/proposals/:id/financing.pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not installed on this deployment.');
    }
    const proposal = await prisma.proposal.findUnique({ where: { id }, select: { number: true } });
    if (!proposal) throw new NotFoundError('Proposal not found');
    const { html } = await renderFinancingHtml(id);
    const pdf = await renderPdf(html, { format: 'Letter' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${proposal.number}-financing.pdf"`)
      .send(pdf);
  });

  /**
   * Send the proposal and the financing sheet to the financing partner.
   *
   * Both documents go together on purpose: the sheet is meaningless without the
   * proposal it was calculated from, and sending one without the other guarantees
   * a follow-up email asking for the other.
   */
  app.post('/proposals/:id/financing/send', write, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const to = parsed.data.to || env.FINANCE_PARTNER_EMAIL;
    const cc = (parsed.data.cc ?? '')
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean);
    for (const a of cc) if (!EMAIL_RE.test(a)) throw new ValidationError(`“${a}” is not a valid email address`);

    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not installed on this deployment, so there is nothing to attach.');
    }
    if (!env.RESEND_API_KEY) {
      throw new ValidationError('No email provider is configured on this deployment (RESEND_API_KEY is unset).');
    }

    const { proposal, quote } = await quoteForProposal(id);
    const { html } = await renderFinancingHtml(id);
    const pdf = await renderPdf(html, { format: 'Letter' });

    const sender = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });

    const money = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const note = (parsed.data.message ?? '').trim();
    const body = [
      'Hello,',
      '',
      `A customer of ours is exploring financing for a sensory gym project and has asked to see their options.`,
      '',
      `Customer: ${proposal.customerName || '—'}`,
      `Proposal: ${proposal.number} (v${proposal.version})`,
      `Project total: ${money(proposal.grandTotalMinor)}`,
      '',
      ...(note ? [note, ''] : []),
      'The financing options sheet we shared with them is attached.',
      '',
      'Thank you,',
      sender?.name ?? 'Summit Sensory Gym',
      'Summit Sensory Gym',
    ].join('\n');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to: [to],
        ...(cc.length ? { cc } : {}),
        // The sender, not the shared orders inbox: a financing question comes back
        // to the person who actually knows the deal.
        reply_to: sender?.email || env.BOM_REPLY_TO,
        subject: `Financing enquiry — ${proposal.customerName || proposal.number} — ${money(proposal.grandTotalMinor)}`,
        html: `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap;">${body
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</div>`,
        attachments: [{ filename: `${proposal.number}-financing.pdf`, content: pdf.toString('base64') }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ proposalId: id, status: res.status }, 'financing send: rejected');
      throw new ValidationError(`The email provider rejected the send (${res.status}): ${text.slice(0, 300)}`);
    }

    await prisma.auditLog.create({
      data: {
        actorId: req.user!.sub,
        action: 'financing.sent',
        entity: 'Proposal',
        entityId: id,
        details: { to, cc, total: proposal.grandTotalMinor, terms: quote.terms.length } as object,
      },
    });

    logger.info({ proposalId: id, to }, 'financing send: sent');
    return { sent: true, to };
  });

  // ------------------------------------------------------------- admin
  /**
   * The payment factors and the two tax settings. Factors rather than an APR
   * because that is what the lessor publishes — see src/proposals/financing.ts.
   */
  app.get('/admin/financing', read, async () => {
    const [factors, settings] = await Promise.all([
      prisma.financeFactor.findMany({ orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }] }),
      prisma.formulaSetting.findMany({ where: { key: { startsWith: 'finance.' } } }),
    ]);
    const byKey = new Map(settings.map((s) => [s.key.replace(/^finance\./, ''), Number(s.value)]));
    return {
      factors: factors.map((f) => ({ ...f, factor: Number(f.factor) })),
      settings: FINANCE_SETTINGS.map((s) => ({ ...s, value: byKey.get(s.key) ?? s.default })),
      partnerEmail: env.FINANCE_PARTNER_EMAIL,
    };
  });

  app.put('/admin/financing/factors/:termMonths', admin, async (req) => {
    const { termMonths } = req.params as { termMonths: string };
    const parsed = FactorSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid factor');
    const term = Number(termMonths);
    const d = parsed.data;
    const row = await prisma.financeFactor.upsert({
      where: { termMonths: term },
      create: {
        termMonths: term,
        factor: d.factor ?? 0,
        active: d.active ?? true,
        sortOrder: d.sortOrder ?? term,
        updatedById: req.user!.sub,
      },
      update: {
        ...(d.factor !== undefined ? { factor: d.factor } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        updatedById: req.user!.sub,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.sub,
        action: 'financing.factor.updated',
        entity: 'FinanceFactor',
        entityId: row.id,
        details: { termMonths: term, factor: Number(row.factor) } as object,
      },
    });
    return { ...row, factor: Number(row.factor) };
  });

  app.delete('/admin/financing/factors/:termMonths', admin, async (req, reply) => {
    const { termMonths } = req.params as { termMonths: string };
    await prisma.financeFactor.delete({ where: { termMonths: Number(termMonths) } }).catch(() => undefined);
    return reply.status(204).send();
  });

  app.put('/admin/financing/settings/:key', admin, async (req) => {
    const { key } = req.params as { key: string };
    const known = FINANCE_SETTINGS.find((s) => s.key === key);
    if (!known) throw new ValidationError('Unknown setting');
    const b = (req.body || {}) as { value?: number };
    const value = Number(b.value);
    if (!Number.isFinite(value)) throw new ValidationError('A number is required');
    if (value < known.min || value > known.max) {
      throw new ValidationError(`${known.label} must be between ${known.min} and ${known.max}`);
    }
    const row = await prisma.formulaSetting.upsert({
      where: { key: `finance.${key}` },
      create: { key: `finance.${key}`, value, updatedById: req.user!.sub },
      update: { value, updatedById: req.user!.sub },
    });
    return { key, value: Number(row.value) };
  });
}

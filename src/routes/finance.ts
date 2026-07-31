import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { financeDocFor, renderFinanceHtml, financeFilename } from '../handoff/financeDocument.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';
import { loadFormulaSettings } from './formulas.js';
import { FORMULA_SETTINGS, setting } from '../proposals/formulaSettings.js';

/**
 * Ryan Capital financing: the payment factors, the sheet, and sending it.
 *
 * Factors are the editable unit rather than an APR — a lessor quotes a published
 * payment factor per term, and deriving one from a rate would introduce a
 * compounding convention Ryan Capital has not agreed to, so the sheet would stop
 * matching what they quote. See `proposals/financing.ts`.
 *
 * A factor change affects documents generated afterwards and never rewrites one
 * already sent: a sent PDF is a file the customer holds. The audit log is the only
 * version history a factor has, which is why every change writes one.
 */

/** The two business numbers the tax panel uses, surfaced on the Financing screen. */
const FINANCE_SETTING_KEYS = ['financeTaxRatePct', 'section179CapDollars'];

const SendSchema = z.object({
  to: z.string().email().optional(),
  cc: z.string().trim().max(400).optional(),
  message: z.string().trim().max(4000).optional(),
});

/**
 * Send the customer's documents — the proposal, the financing sheet, or both.
 *
 * `proposalHtml` is the markup the BROWSER already built for the on-screen preview,
 * posted here to be rendered to PDF. That is deliberate: the proposal layout is a
 * large, evolving template, and a second server-side copy of it would drift from the
 * one the customer sees on screen — exactly how the BOM's Excel export drifted from
 * its PDF. This way there is one proposal layout, not two.
 *
 * It is our own page content, rendered with no network access, and only a proposal
 * writer can reach this route.
 */
const SendDocsSchema = z.object({
  to: z.string().trim().min(3).max(400),
  cc: z.string().trim().max(400).optional(),
  subject: z.string().trim().max(300).optional(),
  message: z.string().trim().max(6000).optional(),
  includeProposal: z.boolean().default(true),
  includeFinancing: z.boolean().default(false),
  /** Required when includeProposal is set — the server has no copy of its own. */
  proposalHtml: z.string().max(4_000_000).optional(),
  proposalFilename: z.string().trim().max(200).optional(),
});

export function registerFinanceRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const manage = { preHandler: requirePermission(Permission.RULES_MANAGE) };

  // ---------------------------------------------------------------- admin
  app.get('/admin/financing', read, async () => {
    const [factors, settings] = await Promise.all([
      prisma.financeFactor.findMany({ orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }] }),
      loadFormulaSettings(),
    ]);
    return {
      factors: factors.map((f) => ({
        termMonths: f.termMonths, factor: Number(f.factor), active: f.active,
      })),
      settings: FORMULA_SETTINGS
        .filter((d) => FINANCE_SETTING_KEYS.includes(d.key))
        .map((d) => ({
          key: d.key, label: d.label, help: d.help, unit: d.unit,
          min: d.min, max: d.max, step: d.step, value: setting(settings, d.key),
        })),
      partnerEmail: env.FINANCE_PARTNER_EMAIL,
    };
  });

  /**
   * Change a term's factor, or stop offering it. Keyed by month count because a term
   * IS its month count — there is no second 36-month option to get confused with.
   */
  app.put('/admin/financing/factors/:termMonths', manage, async (req) => {
    const termMonths = Number((req.params as { termMonths: string }).termMonths);
    if (!Number.isInteger(termMonths) || termMonths < 1) throw new ValidationError('Invalid term');
    const body = (req.body || {}) as { factor?: number; active?: boolean; sortOrder?: number };

    if (body.factor !== undefined) {
      const factor = Number(body.factor);
      // Bound generously: a 6-month term legitimately runs above 0.17 per dollar. The
      // real guard is that zero or negative is nonsense, and a factor above 1 would
      // mean the first payment exceeds the purchase price.
      if (!Number.isFinite(factor) || factor <= 0 || factor > 1) {
        throw new ValidationError('A payment factor must be between 0 and 1 — it is the payment per $1 financed');
      }
    }

    const before = await prisma.financeFactor.findUnique({ where: { termMonths } });
    if (!before && body.factor === undefined) throw new ValidationError('Give a factor when adding a term');

    const row = await prisma.financeFactor.upsert({
      where: { termMonths },
      create: {
        termMonths,
        factor: Number(body.factor),
        active: body.active ?? true,
        sortOrder: body.sortOrder ?? termMonths,
        updatedById: req.user!.sub,
      },
      update: {
        ...(body.factor !== undefined ? { factor: Number(body.factor) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        updatedById: req.user!.sub,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: before ? 'finance.factor.update' : 'finance.factor.create',
      entity: 'FinanceFactor',
      entityId: row.id,
      details: {
        termMonths,
        factor: before ? { from: Number(before.factor), to: Number(row.factor) } : Number(row.factor),
        ...(body.active !== undefined && before && before.active !== row.active
          ? { active: { from: before.active, to: row.active } }
          : {}),
      },
    });
    return { termMonths: row.termMonths, factor: Number(row.factor), active: row.active };
  });

  /** One business number. Shares the formula-settings store, so it is audited there too. */
  app.put('/admin/financing/settings/:key', manage, async (req) => {
    const { key } = req.params as { key: string };
    const def = FORMULA_SETTINGS.find((d) => d.key === key && FINANCE_SETTING_KEYS.includes(d.key));
    if (!def) throw new ValidationError('Unknown financing setting');
    const raw = Number((req.body as { value?: unknown })?.value);
    if (!Number.isFinite(raw)) throw new ValidationError(`${def.label} must be a number`);
    // Clamped rather than rejected: the input already carries min/max, so a value
    // outside them is a stale form, not an argument worth having.
    const value = Math.min(def.max, Math.max(def.min, raw));

    await prisma.formulaSetting.upsert({
      where: { key },
      create: { key, value, updatedById: req.user!.sub },
      update: { value, updatedById: req.user!.sub },
    });
    await recordAudit({
      actorId: req.user!.sub, action: 'formula.settings.update',
      details: { [key]: value, via: 'financing' },
    });
    return { key, value };
  });

  // ---------------------------------------------------------------- the sheet
  app.get('/proposals/:id/financing', read, async (req) => {
    const { id } = req.params as { id: string };
    const doc = await financeDocFor(id);
    return {
      proposal: {
        number: doc.proposalNumber,
        title: doc.proposalTitle,
        version: doc.versionNumber,
        grandTotalMinor: doc.grandTotalMinor,
      },
      customerName: doc.customerName,
      quote: doc.quote,
    };
  });

  /** HTML, so the sheet can be previewed on a deployment without the renderer. */
  app.get('/proposals/:id/financing.html', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = await financeDocFor(id);
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(renderFinanceHtml(doc));
  });

  app.get('/render/proposals/:id/financing.pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = await financeDocFor(id);
    const pdf = await renderPdf(renderFinanceHtml(doc), { format: 'Letter' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${financeFilename(doc.customerName, doc.proposalNumber)}.pdf"`)
      .send(pdf);
  });

  /**
   * Send the sheet to Ryan Capital.
   *
   * The customer has to have asked for this — it puts their name and the value of
   * their purchase in front of a third party — so the audit entry records who sent
   * it, to whom, and for how much.
   */
  app.post('/proposals/:id/financing/send', read, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SendSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const input = parsed.data;

    if (!env.RESEND_API_KEY) throw new ValidationError('Email is not configured on this deployment');
    if (!(await pdfAvailable())) {
      throw new ValidationError('The PDF renderer is not installed on this deployment, so there is nothing to attach');
    }

    const doc = await financeDocFor(id);
    if (!doc.quote.terms.length) throw new ValidationError('This proposal has no amount to finance yet');

    // Only the financing sheet is attached. The customer proposal is still rendered in
    // the browser's print dialog, so the server has no copy to attach — claiming
    // otherwise would send an email that says "proposal attached" with no proposal.
    const attachments = [{
      filename: `${financeFilename(doc.customerName, doc.proposalNumber)}.pdf`,
      content: (await renderPdf(renderFinanceHtml(doc), { format: 'Letter' })).toString('base64'),
    }];

    const to = input.to || env.FINANCE_PARTNER_EMAIL;
    const money = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const subject = `Financing enquiry — ${doc.customerName}${doc.proposalNumber ? ` — ${doc.proposalNumber}` : ''}`;
    const body = [
      input.message?.trim() || `Hello,\n\n${doc.customerName} would like to explore financing for the equipment purchase below.`,
      '',
      `Customer: ${doc.customerName}`,
      `Amount to finance: ${money(doc.quote.amountMinor)}`,
      doc.proposalNumber ? `Proposal: ${doc.proposalNumber} (v${doc.versionNumber})` : '',
      '',
      'The financing options sheet is attached.',
      '',
      'Thank you,',
      doc.preparedBy || 'Summit Sensory Gym',
    ].filter((l) => l !== '').join('\n');

    let ok = false;
    let error: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
          // Replies go to the rep who sent it, not the shared orders inbox: this is a
          // conversation about one customer's application.
          reply_to: env.BOM_REPLY_TO,
          to: [to],
          ...(input.cc ? { cc: input.cc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(env.BOM_BCC_EMAIL ? { bcc: [env.BOM_BCC_EMAIL] } : {}),
          subject,
          text: body,
          attachments,
        }),
      });
      ok = res.ok;
      if (!res.ok) error = `${res.status} ${(await res.text()).slice(0, 300)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Send failed';
    }

    // Recorded either way. A failure that leaves no trace is how someone concludes a
    // partner was contacted when they were not.
    await recordAudit({
      actorId: req.user!.sub,
      action: ok ? 'finance.sent' : 'finance.send_failed',
      entity: 'Proposal',
      entityId: id,
      details: {
        to, cc: input.cc ?? null, amountMinor: doc.quote.amountMinor,
        version: doc.versionNumber, error,
      },
    });
    if (!ok) {
      logger.warn({ err: error, proposalId: id }, 'financing: send failed');
      throw new ValidationError(`Could not send: ${error ?? 'unknown error'}`);
    }
    return { sent: true, to };
  });

  /**
   * One send for both documents, to whoever needs them.
   *
   * The same route serves "proposal and financing together to the customer" and
   * "financing on its own, later, when they ask" — the difference is which boxes are
   * ticked and who is in the To field, not a different feature. Two separate send
   * flows would drift apart and one of them would end up as the neglected one.
   */
  app.post('/proposals/:id/send-documents', write, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SendDocsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const input = parsed.data;

    if (!input.includeProposal && !input.includeFinancing) {
      throw new ValidationError('Choose at least one document to send');
    }
    if (!env.RESEND_API_KEY) throw new ValidationError('Email is not configured on this deployment');
    if (!(await pdfAvailable())) {
      throw new ValidationError('The PDF renderer is not installed on this deployment, so there is nothing to attach');
    }
    if (input.includeProposal && !input.proposalHtml) {
      throw new ValidationError('The proposal could not be prepared — reopen the proposal and try again');
    }

    const doc = await financeDocFor(id);
    const attachments: Array<{ filename: string; content: string }> = [];

    if (input.includeProposal && input.proposalHtml) {
      const name = (input.proposalFilename || `${doc.customerName}-${doc.proposalNumber}`).replace(/\.pdf$/i, '');
      attachments.push({
        filename: `${name}.pdf`,
        content: (await renderPdf(input.proposalHtml, { format: 'Letter' })).toString('base64'),
      });
    }
    if (input.includeFinancing) {
      if (!doc.quote.terms.length) throw new ValidationError('This proposal has no amount to finance yet');
      attachments.push({
        filename: `${financeFilename(doc.customerName, doc.proposalNumber)}.pdf`,
        content: (await renderPdf(renderFinanceHtml(doc), { format: 'Letter' })).toString('base64'),
      });
    }

    const recipients = input.to.split(',').map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) throw new ValidationError('Give at least one recipient');

    const which = [input.includeProposal ? 'proposal' : '', input.includeFinancing ? 'financing options' : '']
      .filter(Boolean).join(' and ');
    const subject = input.subject?.trim()
      || `${doc.customerName}${doc.proposalNumber ? ` — ${doc.proposalNumber}` : ''}${doc.versionNumber > 1 ? ` (Revision ${doc.versionNumber - 1})` : ''}`;
    const body = input.message?.trim()
      || `Hello,\n\nAttached is the ${which} for ${doc.customerName}.\n\nThank you,\n${doc.preparedBy || 'Summit Sensory Gym'}`;

    let ok = false;
    let error: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
          reply_to: env.BOM_REPLY_TO,
          to: recipients,
          ...(input.cc ? { cc: input.cc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(env.BOM_BCC_EMAIL ? { bcc: [env.BOM_BCC_EMAIL] } : {}),
          subject,
          text: body,
          attachments,
        }),
      });
      ok = res.ok;
      if (!res.ok) error = `${res.status} ${(await res.text()).slice(0, 300)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Send failed';
    }

    await recordAudit({
      actorId: req.user!.sub,
      action: ok ? 'proposal.documents.sent' : 'proposal.documents.send_failed',
      entity: 'Proposal',
      entityId: id,
      details: {
        to: recipients, cc: input.cc ?? null, subject,
        documents: attachments.map((a) => a.filename),
        version: doc.versionNumber, error,
      },
    });
    if (!ok) {
      logger.warn({ err: error, proposalId: id }, 'proposal documents: send failed');
      throw new ValidationError(`Could not send: ${error ?? 'unknown error'}`);
    }
    return { sent: true, to: recipients, documents: attachments.map((a) => a.filename) };
  });

  /** Who this proposal's documents would go to by default, and what has been sent. */
  app.get('/proposals/:id/send-context', read, async (req) => {
    const { id } = req.params as { id: string };
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      select: { organizationId: true, number: true, title: true },
    });
    if (!proposal) throw new ValidationError('Proposal not found');
    const contacts = await prisma.contact.findMany({
      where: { organizationId: proposal.organizationId, email: { not: null } },
      orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }],
      select: { firstName: true, lastName: true, email: true, title: true, isDecisionMaker: true },
      take: 8,
    });
    // Past sends, so nobody has to guess whether the customer already has it.
    const history = await prisma.auditLog.findMany({
      where: {
        entity: 'Proposal', entityId: id,
        action: { in: ['proposal.documents.sent', 'finance.sent', 'proposal.documents.send_failed', 'finance.send_failed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { action: true, createdAt: true, details: true, actorId: true },
    });
    const actorIds = [...new Set(history.map((h) => h.actorId).filter(Boolean) as string[])];
    const users = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return {
      partnerEmail: env.FINANCE_PARTNER_EMAIL,
      contacts: contacts.map((c) => ({
        name: `${c.firstName} ${c.lastName}`.trim(),
        email: c.email, title: c.title, isDecisionMaker: c.isDecisionMaker,
      })),
      history: history.map((h) => ({
        action: h.action,
        failed: h.action.endsWith('send_failed'),
        at: h.createdAt.toISOString(),
        by: h.actorId ? nameById.get(h.actorId) ?? null : null,
        details: h.details,
      })),
    };
  });
}

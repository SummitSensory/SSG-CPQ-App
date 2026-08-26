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
import {
  currentRateCard,
  parseRateSheetPaste,
  rateCardById,
  seedBuiltInCard,
  writeRateCard,
  RYAN_CAPITAL_2025,
} from '../proposals/financeRates.js';
import { quoteFinancing, financeSettingsFrom } from '../proposals/financing.js';

/**
 * Ryan Capital financing: the rate sheets, the payment sheet, and sending it.
 *
 * A lessor quotes a published PAYMENT FACTOR per amount band and term, not an APR —
 * deriving one from a rate would introduce a compounding convention Ryan Capital has
 * not agreed to, so the sheet would stop matching what they quote. The factor grid is
 * therefore the editable unit. See `proposals/financeRates.ts`.
 *
 * Rate sheets are versioned: a new sheet from the lessor is a new card with its own
 * effective date, and a proposal that has already had a financing sheet sent keeps
 * the card it was quoted from. Nothing here rewrites a document a customer holds.
 */

/** The two business numbers the tax panel uses, surfaced on the Financing screen. */
const FINANCE_SETTING_KEYS = ['financeTaxRatePct', 'section179CapDollars'];

const SendSchema = z.object({
  to: z.string().email().optional(),
  cc: z.string().trim().max(400).optional(),
  message: z.string().trim().max(4000).optional(),
});

/** A band as the grid editor posts it. Bounds arrive in whole dollars. */
const BandInput = z.object({
  label: z.string().trim().min(1).max(60),
  minDollars: z.number().min(0).max(100_000_000),
  /** Null means "and above" — the top band has no published ceiling. */
  maxDollars: z.number().min(0).max(100_000_000).nullable().optional(),
  /** Keyed by term in months. A term omitted here is a term not offered at this amount. */
  factors: z.record(z.coerce.number().int().min(1).max(120), z.number().positive().lt(1)),
});

const CardInput = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().trim().max(200).optional(),
  effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-01-01'),
  notes: z.string().trim().max(2000).optional(),
  active: z.boolean().optional(),
  bands: z.array(BandInput).min(1).max(40),
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
    const [factors, settings, card, cards] = await Promise.all([
      prisma.financeFactor.findMany({ orderBy: [{ sortOrder: 'asc' }, { termMonths: 'asc' }] }),
      loadFormulaSettings(),
      currentRateCard(),
      prisma.financeRateCard.findMany({
        orderBy: [{ effectiveOn: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          source: true,
          effectiveOn: true,
          active: true,
          notes: true,
          createdAt: true,
          _count: { select: { bands: true } },
        },
        take: 30,
      }),
    ]);
    return {
      factors: factors.map((f) => ({
        termMonths: f.termMonths,
        factor: Number(f.factor),
        active: f.active,
      })),
      settings: FORMULA_SETTINGS.filter((d) => FINANCE_SETTING_KEYS.includes(d.key)).map((d) => ({
        key: d.key,
        label: d.label,
        help: d.help,
        unit: d.unit,
        min: d.min,
        max: d.max,
        step: d.step,
        value: setting(settings, d.key),
      })),
      partnerEmail: env.FINANCE_PARTNER_EMAIL,
      // The sheet quotes are built from right now, expanded, plus the shelf of every
      // sheet on record so an older one can be read or brought back.
      current: card,
      cards: cards.map((c) => ({
        id: c.id,
        name: c.name,
        source: c.source,
        effectiveOn: c.effectiveOn,
        active: c.active,
        notes: c.notes,
        bandCount: c._count.bands,
        isCurrent: card ? c.id === card.id : false,
      })),
      builtIn: { name: RYAN_CAPITAL_2025.name, effectiveOn: RYAN_CAPITAL_2025.effectiveOn },
    };
  });

  /* ---- Rate sheets ---- */

  app.get('/admin/financing/rate-cards/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const card = await rateCardById(id);
    if (!card) throw new ValidationError('That rate sheet no longer exists');
    return card;
  });

  /**
   * Create or replace a rate sheet.
   *
   * The grid is written wholesale rather than patched cell by cell: a grid half
   * updated by a dropped request is a grid that quotes a payment nobody published.
   * Posting to an existing id replaces its bands; posting without one makes a sheet.
   */
  app.post('/admin/financing/rate-cards', manage, async (req, reply) => {
    const parsed = CardInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid rate sheet');
    const id = await saveCard(parsed.data, null, req.user!.sub);
    return reply.status(201).send(await rateCardById(id));
  });

  app.put('/admin/financing/rate-cards/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.financeRateCard.findUnique({ where: { id } });
    if (!existing) throw new ValidationError('That rate sheet no longer exists');
    const parsed = CardInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid rate sheet');
    await saveCard(parsed.data, id, req.user!.sub);
    return rateCardById(id);
  });

  async function saveCard(
    d: z.infer<typeof CardInput>,
    cardId: string | null,
    actorId: string,
  ): Promise<string> {
    const bands = d.bands.map((b) => ({
      label: b.label,
      minMinor: Math.round(b.minDollars * 100),
      maxMinor: b.maxDollars == null ? null : Math.round(b.maxDollars * 100),
      factors: Object.fromEntries(
        Object.entries(b.factors).map(([term, f]) => [Number(term), Number(f)]),
      ) as Record<number, number>,
    }));

    for (const b of bands) {
      if (b.maxMinor != null && b.maxMinor <= b.minMinor) {
        throw new ValidationError(`${b.label}: the top of the band must be above the bottom.`);
      }
      if (!Object.keys(b.factors).length) {
        throw new ValidationError(
          `${b.label}: give at least one term a factor, or remove the band.`,
        );
      }
    }
    // An overlap makes which factor applies depend on sort order, so it is refused
    // here rather than resolved silently at quote time.
    const sorted = [...bands].sort((a, b) => a.minMinor - b.minMinor);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.maxMinor == null) {
        throw new ValidationError(`${prev.label} is open-ended, so it has to be the last band.`);
      }
      if (cur.minMinor < prev.maxMinor) {
        throw new ValidationError(`${prev.label} and ${cur.label} overlap.`);
      }
    }

    const id = await writeRateCard({
      cardId: cardId ?? undefined,
      name: d.name,
      source: d.source ?? null,
      effectiveOn: new Date(`${d.effectiveOn}T00:00:00Z`),
      notes: d.notes ?? null,
      active: d.active,
      bands,
      actorId,
    });
    await recordAudit({
      actorId,
      action: cardId ? 'finance.rateCard.update' : 'finance.rateCard.create',
      entity: 'FinanceRateCard',
      entityId: id,
      details: {
        name: d.name,
        effectiveOn: d.effectiveOn,
        active: d.active ?? false,
        bands: bands.length,
        terms: [...new Set(bands.flatMap((b) => Object.keys(b.factors).map(Number)))].sort(
          (a, b) => a - b,
        ),
      },
    });
    return id;
  }

  /**
   * Read a grid pasted out of the lessor's workbook.
   *
   * Two steps, like the vendor part number importer: without `commit` the parse comes
   * back for review and nothing is written, so the bands and any gaps are seen before
   * a sheet lands.
   */
  app.post('/admin/financing/rate-cards/import', manage, async (req) => {
    const body = (req.body || {}) as {
      text?: string;
      name?: string;
      effectiveOn?: string;
      source?: string;
      commit?: boolean;
      activate?: boolean;
      cardId?: string;
    };
    if (!String(body.text ?? '').trim()) throw new ValidationError('Nothing pasted.');
    const parsed = parseRateSheetPaste(String(body.text));

    const preview = {
      termMonths: parsed.termMonths,
      errors: parsed.errors,
      // Worth flagging on review: the lessor's top row usually carries a ceiling their
      // own formulas do not enforce, and a closed top band turns every larger job into
      // a flagged estimate rather than a quote.
      topBandClosed: parsed.topBandClosed,
      bands: parsed.bands.map((b) => ({
        label: b.label,
        minDollars: b.minMinor / 100,
        maxDollars: b.maxMinor == null ? null : b.maxMinor / 100,
        factors: b.factors,
        // Named rather than inferred: a term with no factor is a term the lessor does
        // not offer at that amount, and the reviewer should confirm that is intended.
        missing: parsed.termMonths.filter((t) => !(t in b.factors)),
      })),
    };
    if (!body.commit) return { committed: false, ...preview };

    // Problems are advisory on review and fatal on commit: a grid with an overlap or a
    // cell that is not a factor must not become the sheet the CRM quotes from.
    if (parsed.errors.length) throw new ValidationError(parsed.errors[0]!);
    if (!parsed.bands.length) throw new ValidationError('No amount bands found in that paste.');

    const effectiveOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.effectiveOn ?? ''))
      ? String(body.effectiveOn)
      : new Date().toISOString().slice(0, 10);

    const id = await saveCard(
      {
        name: String(body.name ?? '').trim() || `Ryan Capital ${effectiveOn.slice(0, 4)}`,
        source: String(body.source ?? '').trim() || 'Pasted from the lessor’s sheet',
        effectiveOn,
        active: false,
        bands: preview.bands.map((b) => ({
          label: b.label,
          minDollars: b.minDollars,
          maxDollars: b.maxDollars,
          factors: b.factors,
        })),
      },
      body.cardId ?? null,
      req.user!.sub,
    );
    if (body.activate === true) await activate(id, req.user!.sub);
    return { committed: true, cardId: id, ...preview };
  });

  /**
   * Publish a sheet. Exactly one card is active, so publishing one stands the others
   * down in the same transaction — two live sheets would make which factor applies
   * depend on query order.
   */
  async function activate(id: string, actorId: string): Promise<void> {
    await prisma.$transaction([
      prisma.financeRateCard.updateMany({ where: { id: { not: id } }, data: { active: false } }),
      prisma.financeRateCard.update({ where: { id }, data: { active: true } }),
    ]);
    await recordAudit({
      actorId,
      action: 'finance.rateCard.activate',
      entity: 'FinanceRateCard',
      entityId: id,
    });
  }

  app.post('/admin/financing/rate-cards/:id/activate', manage, async (req) => {
    const { id } = req.params as { id: string };
    const card = await prisma.financeRateCard.findUnique({
      where: { id },
      include: { _count: { select: { bands: true } } },
    });
    if (!card) throw new ValidationError('That rate sheet no longer exists');
    if (!card._count.bands) {
      throw new ValidationError('That sheet has no bands yet — add rates before publishing it.');
    }
    await activate(id, req.user!.sub);
    return { active: true, id };
  });

  /** Load the built-in 2025 sheet on a fresh database. Refuses once any card exists. */
  app.post('/admin/financing/rate-cards/seed', manage, async (req) => {
    const id = await seedBuiltInCard(req.user!.sub);
    if (!id)
      throw new ValidationError('Rate sheets already exist — paste a new one instead of seeding.');
    await recordAudit({
      actorId: req.user!.sub,
      action: 'finance.rateCard.seed',
      entity: 'FinanceRateCard',
      entityId: id,
      details: { name: RYAN_CAPITAL_2025.name },
    });
    return rateCardById(id);
  });

  /**
   * Delete a sheet. Refused for the live one, and for any sheet a proposal was quoted
   * from — that pin is the only record of what a customer was told.
   */
  app.delete('/admin/financing/rate-cards/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await prisma.financeRateCard.findUnique({ where: { id } });
    if (!card) throw new ValidationError('That rate sheet no longer exists');
    if (card.active)
      throw new ValidationError('This is the sheet in use. Publish another one first.');
    const pinned = await prisma.proposalVersion.count({ where: { financeRateCardId: id } });
    if (pinned) {
      throw new ValidationError(
        `${pinned} proposal${pinned === 1 ? ' was' : 's were'} quoted from this sheet, so it is kept as the record of those payments.`,
      );
    }
    await prisma.financeRateCard.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'finance.rateCard.delete',
      entity: 'FinanceRateCard',
      entityId: id,
      details: { name: card.name },
    });
    return reply.status(204).send();
  });

  /**
   * Try an amount against a sheet without touching a proposal: the band the CRM would
   * pick and the payments it would print. The answer to "is this loaded correctly?".
   */
  app.get('/admin/financing/quote', read, async (req) => {
    const q = req.query as { amount?: string; cardId?: string };
    const dollars = Number(q.amount);
    if (!Number.isFinite(dollars) || dollars <= 0)
      throw new ValidationError('Give an amount to quote.');
    const settings = await loadFormulaSettings();
    return quoteFinancing(
      Math.round(dollars * 100),
      financeSettingsFrom((k) => setting(settings, k)),
      q.cardId ?? null,
    );
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
        throw new ValidationError(
          'A payment factor must be between 0 and 1 — it is the payment per $1 financed',
        );
      }
    }

    const before = await prisma.financeFactor.findUnique({ where: { termMonths } });
    if (!before && body.factor === undefined)
      throw new ValidationError('Give a factor when adding a term');

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
        factor: before
          ? { from: Number(before.factor), to: Number(row.factor) }
          : Number(row.factor),
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
      actorId: req.user!.sub,
      action: 'formula.settings.update',
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
      .header(
        'Content-Disposition',
        `attachment; filename="${financeFilename(doc.customerName, doc.proposalNumber)}.pdf"`,
      )
      .send(pdf);
  });

  /**
   * Send the sheet to Ryan Capital.
   *
   * The customer has to have asked for this — it puts their name and the value of
   * their purchase in front of a third party — so the audit entry records who sent
   * it, to whom, and for how much.
   */
  // Under /render/*: this renders the sheet to PDF before sending, which needs
  // the render function's memory and 60-second ceiling. See vercel.json.
  app.post('/render/proposals/:id/financing/send', read, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SendSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const input = parsed.data;

    if (!env.RESEND_API_KEY)
      throw new ValidationError('Email is not configured on this deployment');
    if (!(await pdfAvailable())) {
      throw new ValidationError(
        'The PDF renderer is not installed on this deployment, so there is nothing to attach',
      );
    }

    const doc = await financeDocFor(id);
    if (!doc.quote.terms.length)
      throw new ValidationError('This proposal has no amount to finance yet');

    // Pin the sheet these payments came from, the first time one goes out. From here
    // on this version quotes from that card, so loading next year's rates cannot
    // restate a payment the customer already has in writing.
    if (doc.quote.basis && !doc.quote.basis.pinned) {
      await prisma.proposalVersion.update({
        where: { id: doc.versionId },
        data: { financeRateCardId: doc.quote.basis.cardId },
      });
    }

    // Only the financing sheet is attached. The customer proposal is still rendered in
    // the browser's print dialog, so the server has no copy to attach — claiming
    // otherwise would send an email that says "proposal attached" with no proposal.
    const attachments = [
      {
        filename: `${financeFilename(doc.customerName, doc.proposalNumber)}.pdf`,
        content: (await renderPdf(renderFinanceHtml(doc), { format: 'Letter' })).toString('base64'),
      },
    ];

    const to = input.to || env.FINANCE_PARTNER_EMAIL;
    const money = (m: number) =>
      `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const subject = `Financing enquiry — ${doc.customerName}${doc.proposalNumber ? ` — ${doc.proposalNumber}` : ''}`;
    const body = [
      input.message?.trim() ||
        `Hello,\n\n${doc.customerName} would like to explore financing for the equipment purchase below.`,
      '',
      `Customer: ${doc.customerName}`,
      `Amount to finance: ${money(doc.quote.amountMinor)}`,
      doc.proposalNumber ? `Proposal: ${doc.proposalNumber} (v${doc.versionNumber})` : '',
      '',
      'The financing options sheet is attached.',
      '',
      'Thank you,',
      doc.preparedBy || 'Summit Sensory Gym',
    ]
      .filter((l) => l !== '')
      .join('\n');

    let ok = false;
    let error: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
          // Replies go to the rep who sent it, not the shared orders inbox: this is a
          // conversation about one customer's application.
          reply_to: env.BOM_REPLY_TO,
          to: [to],
          ...(input.cc
            ? {
                cc: input.cc
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
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
        to,
        cc: input.cc ?? null,
        amountMinor: doc.quote.amountMinor,
        version: doc.versionNumber,
        error,
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
  // Under /render/*, same reason: up to two PDFs are rendered here before the
  // email can be built. On the main API function a cold Chromium start alone put
  // this past the 30-second ceiling, and the browser was left waiting on a
  // request that had already been killed.
  app.post('/render/proposals/:id/send-documents', write, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SendDocsSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const input = parsed.data;

    if (!input.includeProposal && !input.includeFinancing) {
      throw new ValidationError('Choose at least one document to send');
    }
    if (!env.RESEND_API_KEY)
      throw new ValidationError('Email is not configured on this deployment');
    if (!(await pdfAvailable())) {
      throw new ValidationError(
        'The PDF renderer is not installed on this deployment, so there is nothing to attach',
      );
    }
    if (input.includeProposal && !input.proposalHtml) {
      throw new ValidationError(
        'The proposal could not be prepared — reopen the proposal and try again',
      );
    }

    const doc = await financeDocFor(id);
    const attachments: Array<{ filename: string; content: string }> = [];

    if (input.includeProposal && input.proposalHtml) {
      const name = (input.proposalFilename || `${doc.customerName}-${doc.proposalNumber}`).replace(
        /\.pdf$/i,
        '',
      );
      attachments.push({
        filename: `${name}.pdf`,
        // edgeToEdge: the proposal document owns its own page geometry — see render/pdf.ts.
        content: (
          await renderPdf(input.proposalHtml, { format: 'Letter', edgeToEdge: true })
        ).toString('base64'),
      });
    }
    if (input.includeFinancing) {
      if (!doc.quote.terms.length)
        throw new ValidationError('This proposal has no amount to finance yet');
      // Same pin as the financing-only send: whichever route puts payments in front of
      // a customer is the one that fixes which rate sheet produced them.
      if (doc.quote.basis && !doc.quote.basis.pinned) {
        await prisma.proposalVersion.update({
          where: { id: doc.versionId },
          data: { financeRateCardId: doc.quote.basis.cardId },
        });
      }
      attachments.push({
        filename: `${financeFilename(doc.customerName, doc.proposalNumber)}.pdf`,
        content: (await renderPdf(renderFinanceHtml(doc), { format: 'Letter' })).toString('base64'),
      });
    }

    const recipients = input.to
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!recipients.length) throw new ValidationError('Give at least one recipient');

    const which = [
      input.includeProposal ? 'proposal' : '',
      input.includeFinancing ? 'financing options' : '',
    ]
      .filter(Boolean)
      .join(' and ');
    const subject =
      input.subject?.trim() ||
      `${doc.customerName}${doc.proposalNumber ? ` — ${doc.proposalNumber}` : ''}${doc.versionNumber > 1 ? ` (Revision ${doc.versionNumber - 1})` : ''}`;
    const body =
      input.message?.trim() ||
      `Hello,\n\nAttached is the ${which} for ${doc.customerName}.\n\nThank you,\n${doc.preparedBy || 'Summit Sensory Gym'}`;

    let ok = false;
    let error: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
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
        to: recipients,
        cc: input.cc ?? null,
        subject,
        documents: attachments.map((a) => a.filename),
        version: doc.versionNumber,
        error,
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
        entity: 'Proposal',
        entityId: id,
        action: {
          in: [
            'proposal.documents.sent',
            'finance.sent',
            'proposal.documents.send_failed',
            'finance.send_failed',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { action: true, createdAt: true, details: true, actorId: true },
    });
    const actorIds = [...new Set(history.map((h) => h.actorId).filter(Boolean) as string[])];
    const users = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return {
      partnerEmail: env.FINANCE_PARTNER_EMAIL,
      contacts: contacts.map((c) => ({
        name: `${c.firstName} ${c.lastName}`.trim(),
        email: c.email,
        title: c.title,
        isDecisionMaker: c.isDecisionMaker,
      })),
      history: history.map((h) => ({
        action: h.action,
        failed: h.action.endsWith('send_failed'),
        at: h.createdAt.toISOString(),
        by: h.actorId ? (nameById.get(h.actorId) ?? null) : null,
        details: h.details,
      })),
    };
  });
}

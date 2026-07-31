import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { quoteFinancing, financeSettingsFrom, type FinanceQuote } from '../proposals/financing.js';
import { loadFormulaSettings } from '../routes/formulas.js';
import { setting } from '../proposals/formulaSettings.js';
import { COMPANY } from './bom.js';

/**
 * The Ryan Capital financing options sheet.
 *
 * A customer-facing companion to the proposal: the same total, presented as monthly
 * payments across five terms, with the Section 179 first-year tax position beside
 * it. Self-contained HTML — inline styles, no external CSS, no images, no fonts to
 * fetch — for the same reason as the BOM: a renderer that reaches out to the network
 * can hang on a dead asset.
 *
 * It calculates from the accepted (or current) proposal total and takes no input, so
 * there is nothing to fill in and nothing to keep in step by hand.
 */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (minor: number): string =>
  `$${(Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const money0 = (minor: number): string =>
  `$${Math.round(Number(minor || 0) / 100).toLocaleString('en-US')}`;

const longDate = (d: Date): string =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// Summit's document palette, the same ink/slate/paper the proposal and BOM use.
const INK = '#20241f';
const SLATE = '#3d4a55';
const DEEP = '#2c353d';
const MUTED = '#8a8f85';
const PAPER = '#fbfbf9';
const RULE = '#e7e8e3';
const GREEN = '#2f7d5d';

export interface FinanceDoc {
  quote: FinanceQuote;
  customerName: string;
  proposalTitle: string;
  proposalNumber: string;
  preparedBy: string;
  createdAt: Date;
  /** The version the amount came from, for the audit entry. */
  versionId: string;
  versionNumber: number;
  grandTotalMinor: number;
}

/**
 * Build the financing document for a PROPOSAL.
 *
 * The amount comes from the most recent version that has a frozen price snapshot,
 * newest first. The snapshot is used rather than a live recalculation because the
 * total is the number the customer was given, and a financing sheet that quotes a
 * different figure than the proposal beside it is worse than no sheet.
 */
export async function financeDocFor(proposalId: string): Promise<FinanceDoc> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: {
      title: true, number: true, organizationId: true, createdById: true,
      versions: {
        where: { priceSnapshotId: { not: null } },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, priceSnapshotId: true },
      },
    },
  });
  if (!proposal) throw new NotFoundError('Proposal not found');

  const version = proposal.versions[0];
  if (!version?.priceSnapshotId) {
    throw new NotFoundError('This proposal has no priced version yet — save a version first.');
  }

  const [snap, org, author, settings] = await Promise.all([
    prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId }, select: { grandTotal: true } }),
    prisma.organization.findUnique({ where: { id: proposal.organizationId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: proposal.createdById }, select: { name: true } }),
    loadFormulaSettings(),
  ]);
  if (!snap) throw new NotFoundError('Price snapshot not found');

  const grandTotalMinor = Number(snap.grandTotal);
  const quote = await quoteFinancing(grandTotalMinor, financeSettingsFrom((k) => setting(settings, k)));

  return {
    quote,
    customerName: org?.name ?? '',
    proposalTitle: proposal.title ?? '',
    proposalNumber: proposal.number ?? '',
    preparedBy: author?.name ?? '',
    createdAt: new Date(),
    versionId: version.id,
    versionNumber: version.version,
    grandTotalMinor,
  };
}

/** Filesystem-safe basename, matching the BOM convention. */
export function financeFilename(customerName: string, proposalNumber: string): string {
  const part = (v: string) =>
    v.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return [part(customerName), part(proposalNumber), 'Financing_Options'].filter(Boolean).join('-');
}

export function renderFinanceHtml(d: FinanceDoc): string {
  const q = d.quote;

  // The middle term is the one most customers land on, so it leads visually rather
  // than being buried in the middle of five identical rows.
  const featureIdx = q.terms.length ? Math.floor((q.terms.length - 1) / 2) : -1;

  const termCards = q.terms
    .map((t, i) => {
      const lead = i === featureIdx;
      return `<div style="flex:1;min-width:0;padding:10px 10px 9px;border-radius:9px;text-align:center;${
        lead
          ? `background:${DEEP};color:#fff;`
          : `background:${PAPER};border:1px solid ${RULE};color:${INK};`
      }">
        <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.08em;${lead ? 'color:#b9c4cc;' : `color:${MUTED};`}">${t.termMonths} months</div>
        <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;margin:3px 0 0;letter-spacing:-.01em;">${money(t.monthlyPaymentMinor)}</div>
        <div style="font-size:7.5pt;${lead ? 'color:#b9c4cc;' : `color:${MUTED};`}">per month</div>
      </div>`;
    })
    .join('');

  const detailRows = q.terms
    .map(
      (t) => `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid ${RULE};font-size:9pt;">${t.termMonths} months</td>
      <td style="padding:4px 8px;border-bottom:1px solid ${RULE};font-size:9pt;text-align:right;font-weight:600;">${money(t.monthlyPaymentMinor)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid ${RULE};font-size:9pt;text-align:right;">${money(t.totalOfPaymentsMinor)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid ${RULE};font-size:9pt;text-align:right;color:${MUTED};">${money(t.financeChargeMinor)}</td>
    </tr>`,
    )
    .join('');

  const s = q.section179;
  const taxNote = s.exceedsCap
    ? `This purchase exceeds the ${money0(s.capMinor)} annual Section&nbsp;179 limit, so the deduction shown is capped at that limit. The remainder may still be depreciated over time.`
    : `Section&nbsp;179 lets a business deduct the full cost of qualifying equipment in the year it is placed in service, rather than depreciating it over several years.`;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Financing Options — ${esc(d.customerName)}</title>
<style>
  @page { size: Letter; margin: 0.45in; }
  html, body { margin:0; padding:0; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:${INK}; }
  tr { break-inside: avoid; }
</style>
</head>
<body>

  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:9px;border-bottom:2px solid ${INK};">
    <div>
      <div style="font-family:Georgia,serif;font-size:15pt;font-weight:700;letter-spacing:-.01em;">${esc(COMPANY.name)}</div>
      <div style="font-size:8pt;color:${MUTED};line-height:1.45;margin-top:2px;">
        ${esc(COMPANY.addressLine1)}<br>
        ${esc(COMPANY.city)}, ${esc(COMPANY.region)} ${esc(COMPANY.postalCode)}<br>
        ${esc(COMPANY.phone)} · ${esc(COMPANY.email)}
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-family:Georgia,serif;font-size:13.5pt;font-weight:700;">Financing Options</div>
      <div style="font-size:8pt;color:${MUTED};margin-top:2px;line-height:1.45;">
        Prepared for ${esc(d.customerName)}<br>
        ${d.proposalNumber ? `${esc(d.proposalNumber)} · ` : ''}${longDate(d.createdAt)}
      </div>
    </div>
  </div>

  <div style="margin:11px 0 0;">
    <div style="font-size:8.5pt;text-transform:uppercase;letter-spacing:.07em;color:${MUTED};">Amount to finance</div>
    <div style="display:flex;align-items:baseline;gap:12px;margin-top:1px;">
      <div style="font-family:Georgia,serif;font-size:22pt;font-weight:700;letter-spacing:-.015em;">${money(q.amountMinor)}</div>
      <div style="font-size:9pt;color:${MUTED};">${esc(d.proposalTitle)}</div>
    </div>
  </div>

  <div style="display:flex;gap:7px;margin:11px 0 5px;">${termCards}</div>
  <div style="font-size:7.5pt;color:${MUTED};">Estimated monthly payments. Final terms, rate and approval are set by Ryan Capital.</div>

  <div style="font-family:Georgia,serif;font-size:11pt;font-weight:700;margin:14px 0 5px;">Payment detail</div>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>
      ${['Term', 'Monthly payment', 'Total of payments', 'Cost of financing']
    .map(
      (h, i) => `<th style="padding:4px 8px;text-align:${i ? 'right' : 'left'};font-size:7.5pt;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};border-bottom:1.5px solid ${INK};font-weight:600;">${h}</th>`,
    )
    .join('')}
    </tr></thead>
    <tbody>${detailRows}</tbody>
  </table>

  <div style="display:flex;gap:13px;margin-top:15px;align-items:stretch;">
    <div style="flex:1.15;background:${PAPER};border:1px solid ${RULE};border-radius:10px;padding:12px 13px;">
      <div style="font-family:Georgia,serif;font-size:11pt;font-weight:700;">Section 179 tax position</div>
      <div style="font-size:8.5pt;color:${SLATE};line-height:1.45;margin-top:5px;">${taxNote}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:11px;">
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${SLATE};">Purchase price</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:600;">${money(q.amountMinor)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${SLATE};">Deductible this year</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:600;">${money(s.deductionMinor)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${SLATE};border-top:1px solid ${RULE};">Estimated tax saving at ${s.taxRatePct}%</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:700;color:${GREEN};border-top:1px solid ${RULE};">− ${money(s.estimatedSavingsMinor)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0 0;font-size:10pt;font-weight:700;border-top:1.5px solid ${INK};">Net cost after tax saving</td>
          <td style="padding:5px 0 0;font-size:11.5pt;text-align:right;font-family:Georgia,serif;font-weight:700;border-top:1.5px solid ${INK};">${money(s.netCostMinor)}</td>
        </tr>
      </table>
    </div>

    <div style="flex:.85;background:${DEEP};color:#fff;border-radius:10px;padding:12px 13px;">
      <div style="font-family:Georgia,serif;font-size:11pt;font-weight:700;">Ryan Capital</div>
      <div style="font-size:8.5pt;color:#c3ccd3;line-height:1.45;margin-top:6px;">
        Financing for this purchase is arranged through Ryan Capital, an independent
        equipment finance partner. They handle the application, the credit decision
        and the lease documents directly with you.
      </div>
      <div style="margin-top:9px;padding-top:8px;border-top:1px solid #4a5865;font-size:9pt;line-height:1.6;">
        <div style="color:#8fa0ac;font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;">Contact</div>
        <div style="font-weight:600;margin-top:3px;">C. Kinsey</div>
        <div style="color:#c3ccd3;">ckinsey@ryancapital.com</div>
      </div>
      <div style="margin-top:9px;font-size:7.5pt;color:#8fa0ac;line-height:1.55;">
        Tell us you would like to explore financing and we will send this sheet and
        your proposal straight across.
      </div>
    </div>
  </div>

  <div style="margin-top:13px;padding-top:8px;border-top:1px solid ${RULE};font-size:7pt;color:${MUTED};line-height:1.5;">
    Payments are estimates based on Ryan Capital's published payment factors for each
    term and are not an offer of credit; actual terms depend on credit approval and
    may differ. The tax figures are an illustration at a ${s.taxRatePct}% rate and the
    current ${money0(s.capMinor)} Section&nbsp;179 limit — Summit Sensory Gym
    is not a tax advisor, and your own accountant should confirm what your business
    can deduct. Equipment must be placed in service within the tax year to qualify.
    ${d.preparedBy ? `Prepared by ${esc(d.preparedBy)}. ` : ''}${esc(COMPANY.name)}.
  </div>

</body></html>`;
}

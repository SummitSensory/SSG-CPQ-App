import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { quoteFinancing, financeSettingsFrom, type FinanceQuote } from '../proposals/financing.js';
import { loadFormulaSettings } from '../routes/formulas.js';
import { setting } from '../proposals/formulaSettings.js';
import { COMPANY } from './bom.js';
import { LOGO_DATA_URI, BRAND } from './brandLogo.js';

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
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (minor: number): string =>
  `$${(Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const money0 = (minor: number): string =>
  `$${Math.round(Number(minor || 0) / 100).toLocaleString('en-US')}`;

const longDate = (d: Date): string =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

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
 *
 * The rate card is the one the version was pinned to when a sheet was last SENT, or
 * the current card when none has been. Re-rendering a sheet a customer already holds
 * therefore reproduces their payments rather than today's.
 */
export async function financeDocFor(proposalId: string): Promise<FinanceDoc> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: {
      title: true,
      number: true,
      organizationId: true,
      createdById: true,
      versions: {
        where: { priceSnapshotId: { not: null } },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, priceSnapshotId: true, financeRateCardId: true },
      },
    },
  });
  if (!proposal) throw new NotFoundError('Proposal not found');

  const version = proposal.versions[0];
  if (!version?.priceSnapshotId) {
    throw new NotFoundError('This proposal has no priced version yet — save a version first.');
  }

  const [snap, org, author, settings] = await Promise.all([
    prisma.priceSnapshot.findUnique({
      where: { id: version.priceSnapshotId },
      select: { grandTotal: true },
    }),
    prisma.organization.findUnique({
      where: { id: proposal.organizationId },
      select: { name: true },
    }),
    prisma.user.findUnique({ where: { id: proposal.createdById }, select: { name: true } }),
    loadFormulaSettings(),
  ]);
  if (!snap) throw new NotFoundError('Price snapshot not found');

  const grandTotalMinor = Number(snap.grandTotal);
  const quote = await quoteFinancing(
    grandTotalMinor,
    financeSettingsFrom((k) => setting(settings, k)),
    version.financeRateCardId,
  );

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
    v
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  return [part(customerName), part(proposalNumber), 'Financing_Options'].filter(Boolean).join('-');
}

/**
 * Why financing is worth considering at all.
 *
 * Page two of the sheet. Held as data rather than markup so the copy is edited in one
 * place and the numbering stays in step when an item is added or removed. The wording
 * is the customer-facing text as approved — it is not paraphrased at render time.
 */
export const FINANCING_BENEFITS: Array<{ title: string; body: string }> = [
  {
    title: 'Preserve Your Working Capital',
    body: 'Keep more cash available for staffing, facility improvements, marketing, operating expenses, and other organizational priorities.',
  },
  {
    title: 'Choose a Payment That Fits Your Budget',
    body: 'Multiple term options can convert a substantial equipment investment into a more manageable monthly payment. Summit’s current financing program provides estimated options ranging from 12 to 60 months.',
  },
  {
    title: 'Move Your Project Forward Sooner',
    body: 'Financing may allow you to begin building your therapy space now rather than waiting for another budget cycle or until the full purchase amount is available.',
  },
  {
    title: 'Use the Equipment While You Pay for It',
    body: 'Spread the investment over time while your clinicians, educators, students, and clients are already benefiting from the new equipment and therapy environment.',
  },
  {
    title: 'Make Stakeholder Approval Easier',
    body: 'Presenting clear monthly payment scenarios can make the project easier to evaluate for owners, administrators, finance teams, boards, and other decision-makers.',
  },
  {
    title: 'Maintain Flexibility for Future Growth',
    body: 'Preserving capital gives your organization more room to respond to new opportunities, unexpected expenses, or additional program and equipment needs.',
  },
  {
    title: 'Explore Potential Tax Advantages',
    body: 'Qualifying equipment may be eligible for a Section 179 deduction in the year it is placed in service, potentially reducing the effective cost of the investment. Eligibility and tax impact should always be confirmed with your accountant.',
  },
  {
    title: 'Benefit From a Streamlined Process',
    body: 'Financing is arranged through Ryan Capital, an independent equipment finance partner that handles the application, credit decision, and financing documents directly with the customer.',
  },
];

/** Ryan Capital's contact of record, printed on both pages. */
const PARTNER = { name: 'Chandler Kinsey', email: 'ckinsey@ryancapital.com' };

const B = BRAND;

/**
 * The financing sheet: two Letter pages.
 *
 * Page one is this proposal's arithmetic — the amount, the terms, what each costs in
 * total, and the Section 179 position. Page two is why an organization would finance
 * at all, which is the question a customer has to take to a board.
 *
 * Colour does one job here: it points. Navy carries the brand and every figure that
 * matters; the red from the mark appears three times only — the FINANCING label, the
 * rule above the featured term, and the benefit numerals — and everything else is
 * neutral. A page where everything is emphasised emphasises nothing, and a financing
 * document that reads as a flyer is one a finance committee discounts.
 */
export function renderFinanceHtml(d: FinanceDoc): string {
  const q = d.quote;

  // The middle term is where most customers land, so it leads the row rather than
  // sitting unremarked in the middle of five identical cards.
  const featureIdx = q.terms.length ? Math.floor((q.terms.length - 1) / 2) : -1;

  const termCards = q.terms
    .map((t, i) => {
      const lead = i === featureIdx;
      return `<div style="flex:${lead ? '1.06' : '1'};min-width:0;${
        lead
          ? `background:${B.navy};border:1px solid ${B.navy};border-top:3px solid ${B.red};`
          : `border:1px solid ${B.navyRule};border-top:3px solid #cbd3e4;`
      }border-radius:8px;padding:9px 8px 8px;text-align:center;">
        <div style="font-size:7pt;text-transform:uppercase;letter-spacing:.09em;font-weight:600;color:${lead ? '#a9b6d6' : B.muted};">${t.termMonths} months</div>
        <div style="font-family:Georgia,serif;font-size:${lead ? '16pt' : '15pt'};font-weight:700;margin:3px 0 0;letter-spacing:-.015em;color:${lead ? '#fff' : B.navy};">${money(t.monthlyPaymentMinor)}</div>
        <div style="font-size:7pt;color:${lead ? '#a9b6d6' : B.faint};">per month</div>
      </div>`;
    })
    .join('');

  const detailRows = q.terms
    .map((t, i) => {
      const lead = i === featureIdx;
      const cell = `border-bottom:1px solid ${B.rule};font-size:9pt;`;
      return `<tr${lead ? ' style="background:#f7f9fd;"' : ''}>
      <td style="padding:5px 9px 5px 0;${cell}${lead ? 'font-weight:600;' : ''}">${t.termMonths} months</td>
      <td style="padding:5px 9px;${cell}text-align:right;font-weight:700;color:${B.navy};">${money(t.monthlyPaymentMinor)}</td>
      <td style="padding:5px 9px;${cell}text-align:right;">${money(t.totalOfPaymentsMinor)}</td>
      <td style="padding:5px 0 5px 9px;${cell}text-align:right;color:${B.muted};">${money(t.financeChargeMinor)}</td>
    </tr>`;
    })
    .join('');

  const s = q.section179;
  const taxNote = s.exceedsCap
    ? `This purchase exceeds the ${money0(s.capMinor)} annual Section&nbsp;179 limit, so the deduction shown is capped at that limit. The remainder may still be depreciated over time.`
    : 'Section&nbsp;179 lets a business deduct the full cost of qualifying equipment in the year it is placed in service, rather than depreciating it over several years.';

  // Where the factors came from. A payment a customer can act on should name the
  // published sheet behind it, and when the amount sits outside that sheet's bands the
  // figure is an approximation — saying so is the difference between an estimate and a
  // misquote.
  const basis = q.basis;
  const bandNote = basis
    ? basis.approximate
      ? `These payments use the ${esc(basis.bandLabel)} band of ${esc(basis.cardName)}, the closest published to this amount — Ryan Capital have not published factors ${
          basis.direction === 'above' ? 'above' : 'below'
        } it, so treat the figures as an estimate and ask them to confirm.`
      : `Payment factors from ${esc(basis.cardName)}, ${esc(basis.bandLabel)} band.`
    : '';

  const th = (label: string, align: 'left' | 'right'): string =>
    `<th style="padding:4px ${align === 'left' ? '9px 4px 0' : '9px'};text-align:${align};font-size:7pt;text-transform:uppercase;letter-spacing:.08em;color:${B.muted};border-bottom:1.5px solid ${B.navy};font-weight:700;">${label}</th>`;

  const benefits = FINANCING_BENEFITS.map(
    (b, i) => `<div style="display:flex;gap:8px;align-items:baseline;">
      <div style="font-family:Georgia,serif;font-size:9pt;font-weight:700;color:${B.red};flex:none;width:14px;">${String(i + 1).padStart(2, '0')}</div>
      <div>
        <div style="font-size:9.5pt;font-weight:700;color:${B.navy};line-height:1.3;">${esc(b.title)}</div>
        <div style="font-size:8.5pt;color:${B.body};line-height:1.5;margin-top:2px;">${esc(b.body)}</div>
      </div>
    </div>`,
  ).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Financing Options — ${esc(d.customerName)}</title>
<style>
  @page { size: Letter; margin: 0.45in; }
  html, body { margin:0; padding:0; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:${B.ink}; }
  tr { break-inside: avoid; }
  .page2 { page-break-before: always; break-before: page; }
</style>
</head>
<body>

  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:22px;padding-bottom:10px;border-bottom:2.5px solid ${B.navy};">
    <div style="display:flex;gap:11px;align-items:flex-start;">
      <img src="${LOGO_DATA_URI}" alt="" style="width:52px;height:52px;display:block;flex:none;">
      <div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14.5pt;font-weight:700;letter-spacing:-.01em;color:${B.navy};line-height:1.15;">${esc(COMPANY.name)}</div>
        <div style="font-size:7.5pt;color:${B.muted};line-height:1.5;margin-top:3px;">
          ${esc(COMPANY.addressLine1)}, ${esc(COMPANY.city)}, ${esc(COMPANY.region)} ${esc(COMPANY.postalCode)}<br>
          ${esc(COMPANY.phone)} · ${esc(COMPANY.email)}
        </div>
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-family:Georgia,serif;font-size:15pt;font-weight:700;line-height:1.1;white-space:nowrap;"><span style="color:${B.red};">Financing</span> <span style="color:${B.navy};">Options</span></div>
      <div style="font-size:8pt;color:${B.muted};margin-top:4px;line-height:1.5;">
        Prepared for ${esc(d.customerName)}<br>
        ${d.proposalNumber ? `${esc(d.proposalNumber)} · ` : ''}${longDate(d.createdAt)}
      </div>
    </div>
  </div>

  <div style="margin:13px 0 0;padding:13px 16px;background:${B.navyTint};border-radius:10px;">
    <div style="font-family:Georgia,serif;font-size:13pt;font-weight:700;color:${B.navy};line-height:1.3;letter-spacing:-.01em;">
      Open The Space This Year — And Let It Start Working While You Pay For It.
    </div>
    <div style="font-size:8.5pt;color:${B.body};line-height:1.5;margin-top:4px;max-width:6.1in;">
      The same project, spread across a term that fits the budget you already have. Below are estimated
      monthly payments for this proposal, and what each term costs in total.
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin:14px 0 0;">
    <div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.12em;color:${B.muted};font-weight:600;">Amount to finance</div>
      <div style="font-family:Georgia,serif;font-size:26pt;font-weight:700;letter-spacing:-.02em;color:${B.navy};line-height:1.05;margin-top:2px;">${money(q.amountMinor)}</div>
    </div>
    <div style="text-align:right;font-size:8.5pt;color:${B.muted};line-height:1.45;padding-bottom:3px;">${esc(d.proposalTitle)}</div>
  </div>

  <div style="display:flex;gap:6px;margin:12px 0 5px;">${termCards}</div>
  <div style="font-size:7pt;color:${B.faint};">Estimated monthly payments. Final terms, rate and approval are set by Ryan Capital.</div>
  ${
    basis && basis.approximate
      ? `<div style="margin-top:6px;padding:6px 9px;background:#fdf8ec;border:1px solid #ecdcb4;border-radius:7px;font-size:8pt;color:#7a5c1a;line-height:1.45;">${bandNote}</div>`
      : ''
  }

  <div style="font-family:Georgia,serif;font-size:11pt;font-weight:700;color:${B.navy};margin:15px 0 5px;">Payment Detail</div>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>${th('Term', 'left')}${th('Monthly payment', 'right')}${th('Total of payments', 'right')}${th('Cost of financing', 'right')}</tr></thead>
    <tbody>${detailRows}</tbody>
  </table>

  <div style="display:flex;gap:11px;margin-top:15px;align-items:stretch;">

    <div style="flex:1.18;background:${B.navyTint};border-radius:10px;padding:12px 14px;">
      <div style="font-family:Georgia,serif;font-size:10.5pt;font-weight:700;color:${B.navy};">Section 179 Tax Position</div>
      <div style="font-size:8pt;color:${B.body};line-height:1.45;margin-top:4px;">${taxNote}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:9px;">
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${B.body};">Purchase Price</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:600;">${money(q.amountMinor)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${B.body};">Deductible This Year</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:600;">${money(s.deductionMinor)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;font-size:9pt;color:${B.body};border-top:1px solid ${B.navyRule};">Estimated Tax Saving At ${s.taxRatePct}%</td>
          <td style="padding:3px 0;font-size:9pt;text-align:right;font-weight:700;color:${B.green};border-top:1px solid ${B.navyRule};">− ${money(s.estimatedSavingsMinor)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0 0;font-size:9.5pt;font-weight:700;color:${B.navy};border-top:1.5px solid ${B.navy};">Net Cost After Tax Saving</td>
          <td style="padding:5px 0 0;font-size:11.5pt;text-align:right;font-family:Georgia,serif;font-weight:700;color:${B.navy};border-top:1.5px solid ${B.navy};">${money(s.netCostMinor)}</td>
        </tr>
      </table>
    </div>

    <div style="flex:.82;background:${B.navy};color:#fff;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${B.red};"></div>
      <div style="font-family:Georgia,serif;font-size:10.5pt;font-weight:700;">Ryan Capital</div>
      <div style="font-size:8pt;color:${B.navyOnDark};line-height:1.45;margin-top:5px;">
        Financing for this purchase is arranged through Ryan Capital, an independent equipment
        finance partner. They handle the application, the credit decision and the financing
        documents directly with you.
      </div>
      <div style="margin-top:9px;padding-top:8px;border-top:1px solid #3c4c78;">
        <div style="font-size:7pt;text-transform:uppercase;letter-spacing:.1em;color:${B.navyFaint};font-weight:600;">Contact</div>
        <div style="font-size:9.5pt;font-weight:700;margin-top:3px;">${esc(PARTNER.name)}</div>
        <div style="font-size:8.5pt;color:${B.navyOnDark};">${esc(PARTNER.email)}</div>
      </div>
      <div style="margin-top:9px;font-size:7.5pt;color:${B.navyFaint};line-height:1.5;">
        Tell us you would like to explore financing and we will send this sheet and your proposal
        straight across.
      </div>
    </div>

  </div>

  <div style="margin-top:12px;padding-top:8px;border-top:1px solid ${B.rule};font-size:6.5pt;color:${B.faint};line-height:1.5;">
    Payments are estimates based on Ryan Capital's published payment factors for the amount and term
    shown and are not an offer of credit; actual terms depend on credit approval and may differ.${basis && !basis.approximate ? ` ${bandNote}` : ''} The tax
    figures are an illustration at a ${s.taxRatePct}% rate and the current ${money0(s.capMinor)}
    Section&nbsp;179 limit — ${esc(COMPANY.name)} is not a tax advisor, and your own accountant should
    confirm what your business can deduct. Equipment must be placed in service within the tax year to
    qualify. ${d.preparedBy ? `Prepared by ${esc(d.preparedBy)}. ` : ''}${esc(COMPANY.name)}.
  </div>

  <div class="page2">

    <div style="display:flex;justify-content:space-between;align-items:center;gap:20px;padding-bottom:8px;border-bottom:2.5px solid ${B.navy};">
      <div style="display:flex;gap:9px;align-items:center;">
        <img src="${LOGO_DATA_URI}" alt="" style="width:34px;height:34px;display:block;flex:none;">
        <div style="font-family:Georgia,serif;font-size:11pt;font-weight:700;color:${B.navy};">${esc(COMPANY.name)}</div>
      </div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.12em;color:${B.muted};font-weight:600;">Why organizations finance</div>
    </div>

    <div style="font-family:Georgia,serif;font-size:17pt;font-weight:700;color:${B.navy};letter-spacing:-.015em;line-height:1.15;margin:14px 0 0;max-width:6.6in;">
      Flexible Financing Makes It Easier to Move Forward
    </div>
    <div style="font-size:9.5pt;color:${B.body};line-height:1.55;margin-top:7px;max-width:6.5in;text-wrap:pretty;">
      Investing in a new therapy environment is a significant decision—but it does not have to require one
      large upfront payment. Financing can help clinics, schools, and care organizations obtain the
      equipment they need while maintaining greater financial flexibility.
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px 20px;margin-top:15px;">${benefits}</div>

    <div style="margin-top:16px;background:${B.navy};color:#fff;border-radius:10px;padding:14px 16px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${B.red};"></div>
      <div style="font-family:Georgia,serif;font-size:12pt;font-weight:700;line-height:1.3;max-width:6.2in;">
        Build The Therapy Environment Your Organization Needs Without Placing The Full Cost Into
        Today’s Budget.
      </div>
      <div style="font-size:9pt;color:${B.navyOnDark};line-height:1.5;margin-top:5px;max-width:6.2in;">
        Ask ${esc(COMPANY.name)} to include estimated financing options with your proposal, and we will
        help connect you with Ryan Capital to explore available terms.
      </div>
      <div style="display:flex;gap:22px;margin-top:11px;padding-top:10px;border-top:1px solid #3c4c78;font-size:8.5pt;">
        <div>
          <div style="font-size:7pt;text-transform:uppercase;letter-spacing:.1em;color:${B.navyFaint};font-weight:600;">${esc(COMPANY.name)}</div>
          <div style="margin-top:2px;">${esc(COMPANY.phone)} · ${esc(COMPANY.email)}</div>
        </div>
        <div>
          <div style="font-size:7pt;text-transform:uppercase;letter-spacing:.1em;color:${B.navyFaint};font-weight:600;">Ryan Capital</div>
          <div style="margin-top:2px;">${esc(PARTNER.name)} · ${esc(PARTNER.email)}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:12px;padding-top:8px;border-top:1px solid ${B.rule};font-size:6.5pt;color:${B.faint};line-height:1.5;">
      Payments are estimates and are not an offer of credit. Actual rates, payments, terms, and approval
      are determined by Ryan Capital and may vary. ${esc(COMPANY.name)} is not a tax advisor. Please
      consult your accountant to confirm Section 179 eligibility and potential tax benefits.
    </div>

  </div>

</body></html>`;
}

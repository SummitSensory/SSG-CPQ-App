import { quoteForProposal } from './financing.js';

/**
 * The Ryan Capital financing options sheet.
 *
 * A second document alongside the proposal, showing what the same purchase looks
 * like financed over each available term. Everything on it is derived from the
 * proposal total — there is nothing for anyone to fill in, and no version of this
 * sheet can disagree with the proposal it was generated from.
 *
 * Self-contained HTML: inline styles, no external CSS, no images, no web fonts.
 * The PDF renderer prints it exactly as the browser does.
 */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (minor: number): string =>
  `$${(Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const money0 = (minor: number): string =>
  `$${Math.round(Number(minor || 0) / 100).toLocaleString('en-US')}`;

// Summit's palette, matching the application shell.
const INK = '#20241f';
const MUTED = '#5c6157';
const LINE = '#e7e8e3';
const PAPER = '#fbfbf9';
const GOLD = '#c9a227';
const GREEN = '#2f6b4f';

export async function renderFinancingHtml(proposalId: string): Promise<{ html: string; title: string }> {
  const { proposal, quote } = await quoteForProposal(proposalId);
  const s = quote.section179;

  // The shortest term costs the least overall and the longest is the smallest
  // monthly — worth pointing at, because it is the trade-off the customer is
  // actually weighing.
  const lowestPayment = quote.terms.reduce((a, b) => (b.monthlyPaymentMinor < a.monthlyPaymentMinor ? b : a), quote.terms[0]);

  const termCards = quote.terms
    .map((t) => {
      const feature = t.termMonths === 60;
      return `<div style="flex:1;min-width:118px;border:1px solid ${feature ? GOLD : LINE};border-radius:11px;padding:14px 12px;background:${feature ? '#fdfaf0' : '#fff'};text-align:center;">
        <div style="font-size:8.5pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">${t.termMonths} months</div>
        <div style="font-family:Georgia,serif;font-size:19pt;font-weight:700;color:${INK};margin:7px 0 2px;letter-spacing:-.02em;">${money0(t.monthlyPaymentMinor)}</div>
        <div style="font-size:8pt;color:${MUTED};">per month</div>
        <div style="margin-top:9px;padding-top:9px;border-top:1px solid ${LINE};font-size:8pt;color:${MUTED};line-height:1.5;">
          ${money0(t.totalOfPaymentsMinor)} total<br>${money0(t.costOfFinancingMinor)} financing cost
        </div>
      </div>`;
    })
    .join('');

  const tableRows = quote.terms
    .map(
      (t) => `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid ${LINE};font-size:9.5pt;font-weight:600;">${t.termMonths} months</td>
      <td style="padding:9px 10px;border-bottom:1px solid ${LINE};font-size:9.5pt;text-align:right;font-family:Georgia,serif;font-size:11pt;font-weight:700;">${money(t.monthlyPaymentMinor)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid ${LINE};font-size:9.5pt;text-align:right;">${money(t.totalOfPaymentsMinor)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid ${LINE};font-size:9.5pt;text-align:right;color:${MUTED};">${money(t.costOfFinancingMinor)}</td>
    </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Financing options — ${esc(proposal.number)}</title>
<style>
  @page { margin: 0.5in; }
  body { margin:0; font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; color:${INK}; }
  tr { break-inside: avoid; }
</style>
</head>
<body>

  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:13px;border-bottom:2px solid ${INK};">
    <div>
      <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;letter-spacing:-.015em;">Summit Sensory Gym</div>
      <div style="font-size:8.5pt;color:${MUTED};margin-top:3px;">Financing options prepared for ${esc(proposal.customerName || 'your organization')}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:9.5pt;font-weight:600;">${esc(proposal.number)}</div>
      <div style="font-size:8.5pt;color:${MUTED};margin-top:2px;">Version ${proposal.version}</div>
      <div style="font-size:8.5pt;color:${MUTED};">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
    </div>
  </div>

  <div style="margin:20px 0 6px;">
    <h1 style="font-family:Georgia,serif;font-size:20pt;margin:0;font-weight:700;letter-spacing:-.02em;">Ways to pay for this project</h1>
    <p style="font-size:10pt;color:${MUTED};line-height:1.6;margin:8px 0 0;max-width:6.2in;">
      Financing through Ryan Capital spreads the cost of your sensory gym across the years you will use it,
      and typically lets the equipment qualify for a first-year tax deduction. The figures below are calculated
      from your proposal total — no application is needed to see them.
    </p>
  </div>

  <div style="display:flex;gap:14px;margin:20px 0;padding:15px 17px;background:${PAPER};border:1px solid ${LINE};border-radius:12px;">
    <div style="flex:1;">
      <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">Project total</div>
      <div style="font-family:Georgia,serif;font-size:22pt;font-weight:700;letter-spacing:-.02em;margin-top:3px;">${money(quote.amountFinancedMinor)}</div>
    </div>
    <div style="width:1px;background:${LINE};"></div>
    <div style="flex:1;">
      <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">Lowest monthly payment</div>
      <div style="font-family:Georgia,serif;font-size:22pt;font-weight:700;letter-spacing:-.02em;margin-top:3px;color:${GREEN};">${money(lowestPayment.monthlyPaymentMinor)}</div>
      <div style="font-size:8.5pt;color:${MUTED};margin-top:1px;">over ${lowestPayment.termMonths} months</div>
    </div>
  </div>

  <div style="display:flex;gap:9px;margin:18px 0;">${termCards}</div>

  <h2 style="font-family:Georgia,serif;font-size:13pt;margin:24px 0 9px;font-weight:700;">Every term, side by side</h2>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>
      <th style="padding:7px 10px;text-align:left;font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};border-bottom:1.5px solid ${INK};font-weight:600;">Term</th>
      <th style="padding:7px 10px;text-align:right;font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};border-bottom:1.5px solid ${INK};font-weight:600;">Monthly payment</th>
      <th style="padding:7px 10px;text-align:right;font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};border-bottom:1.5px solid ${INK};font-weight:600;">Total of payments</th>
      <th style="padding:7px 10px;text-align:right;font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};border-bottom:1.5px solid ${INK};font-weight:600;">Cost of financing</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>

  <h2 style="font-family:Georgia,serif;font-size:13pt;margin:26px 0 9px;font-weight:700;">Section 179 tax treatment</h2>
  <div style="border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
    <div style="display:flex;">
      <div style="flex:1;padding:14px 16px;border-right:1px solid ${LINE};">
        <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">Qualifying deduction</div>
        <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;margin-top:4px;">${money(s.deductionMinor)}</div>
      </div>
      <div style="flex:1;padding:14px 16px;border-right:1px solid ${LINE};">
        <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">Estimated tax savings</div>
        <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;margin-top:4px;color:${GREEN};">${money(s.estimatedSavingsMinor)}</div>
        <div style="font-size:8pt;color:${MUTED};margin-top:2px;">at a ${s.taxRatePct}% rate</div>
      </div>
      <div style="flex:1;padding:14px 16px;background:${PAPER};">
        <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:${MUTED};font-weight:600;">Net cost after deduction</div>
        <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;margin-top:4px;">${money(s.netCostMinor)}</div>
      </div>
    </div>
    ${
      s.exceedsCap
        ? `<div style="padding:10px 16px;border-top:1px solid ${LINE};background:#fdf6e6;font-size:9pt;color:#6b5a24;line-height:1.55;">
            This project exceeds the ${money0(s.capMinor)} Section 179 cap. The amount above the cap may still be
            depreciated under other provisions — your accountant can advise.
          </div>`
        : ''
    }
  </div>

  <div style="margin-top:22px;padding:14px 16px;border:1px solid ${LINE};border-left:3px solid ${GOLD};border-radius:10px;background:${PAPER};">
    <div style="font-size:10pt;font-weight:650;margin-bottom:4px;">Interested in financing?</div>
    <p style="font-size:9.5pt;color:${MUTED};line-height:1.6;margin:0;">
      Let your Summit representative know and we will introduce you to Ryan Capital, who handle the application
      directly. Approval typically takes one to two business days, and there is no obligation in asking.
    </p>
  </div>

  <div style="margin-top:20px;padding-top:12px;border-top:1px solid ${LINE};font-size:7.5pt;color:#8a8f85;line-height:1.6;">
    <b style="color:${MUTED};">About these figures.</b>
    Payments are estimates based on payment factors published by Ryan Capital and are subject to credit approval
    and final documentation; they are not an offer of credit. Tax figures are illustrative only — Summit Sensory Gym
    does not provide tax advice, and the value of any deduction depends on your circumstances. Confirm the treatment
    with your own accountant before relying on it.
  </div>

</body></html>`;

  return { html, title: `Financing options — ${proposal.number}` };
}

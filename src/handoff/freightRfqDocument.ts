import { buildRfqModel, type RfqModel } from './freightRfq.js';

/**
 * The Request for Freight document.
 *
 * Self-contained HTML: inline styles, no external CSS and no webfonts, for the
 * same reason the BOM is built this way — the PDF renderer must not depend on
 * the network to produce a document a vendor is waiting on.
 *
 * Letter, with the product table allowed to break across pages and the ship-to,
 * contact and submission blocks kept whole.
 */

const INK = '#20241f';
const MUTED = '#5f6b5c';
const RULE = '#d7ddd3';
const BAND = '#f2f5f0';

const money = (minor: number): string =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Filesystem-safe basename: "RFQ-8050 R2 - Southpaw - Lynch Pediatric Therapy". */
export function rfqFilename(reference: string, vendor: string, customer = ''): string {
  return [reference, vendor, customer]
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:7px 12px;border-bottom:1px solid ${RULE};color:${MUTED};font-size:11px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;vertical-align:top;width:190px;">${esc(label)}</td>
    <td style="padding:7px 12px;border-bottom:1px solid ${RULE};font-size:13px;vertical-align:top;">${value}</td>
  </tr>`;
}

function block(title: string, rows: string): string {
  return `<section style="page-break-inside:avoid;margin:0 0 22px;">
    <h2 style="margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${MUTED};font-weight:700;">${esc(title)}</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid ${RULE};">${rows}</table>
  </section>`;
}

export function renderRfqDocument(m: RfqModel): string {
  const included = m.lines.filter((l) => l.included);

  const productRows = included
    .map(
      (l, i) => `<tr style="background:${i % 2 ? BAND : '#ffffff'};">
        <td style="padding:8px 10px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;">${esc(l.sku)}</td>
        <td style="padding:8px 10px;font-size:12px;">${esc(l.name)}</td>
        <td style="padding:8px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;">${l.quantity}</td>
        <td style="padding:8px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;">${money(l.unitCostMinor)}</td>
        <td style="padding:8px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;">${money(l.extendedCostMinor)}</td>
      </tr>`,
    )
    .join('');

  const notes = m.notes
    ? `<section style="page-break-inside:avoid;margin:0 0 22px;">
        <h2 style="margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${MUTED};font-weight:700;">Special notes</h2>
        <div style="border:1px solid ${RULE};padding:12px 14px;font-size:13px;line-height:1.55;white-space:pre-wrap;">${esc(m.notes)}</div>
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(m.reference)}</title>
<style>
  @page { size: Letter; margin: 0.6in 0.65in 0.75in; }
  * { box-sizing: border-box; }
  body { margin:0; color:${INK}; font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <header style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid ${INK};padding-bottom:12px;margin-bottom:20px;">
    <div>
      <div style="font-size:20px;font-weight:700;letter-spacing:-.01em;">Request for Freight (RFQ)</div>
      <div style="margin-top:4px;font-size:12px;color:${MUTED};">${esc(m.company.name)} · ${esc(m.company.addressLine1)}, ${esc(m.company.city)}, ${esc(m.company.region)} ${esc(m.company.postalCode)}</div>
    </div>
    <table style="border-collapse:collapse;font-size:12px;">
      <tr><td style="padding:2px 0 2px 0;color:${MUTED};">Today's Date</td><td style="padding:2px 0 2px 16px;text-align:right;font-weight:600;">${esc(m.todayLabel)}</td></tr>
      <tr><td style="padding:2px 0;color:${MUTED};">Reference ID</td><td style="padding:2px 0 2px 16px;text-align:right;font-weight:700;">${esc(m.reference)}</td></tr>
      <tr><td style="padding:2px 0;color:${MUTED};">Vendor</td><td style="padding:2px 0 2px 16px;text-align:right;font-weight:600;">${esc(m.vendor)}</td></tr>
    </table>
  </header>

  <section style="margin:0 0 22px;">
    <h2 style="margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${MUTED};font-weight:700;">Product</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1.5px solid ${INK};">
          <th style="padding:7px 10px;text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};white-space:nowrap;">SKU</th>
          <th style="padding:7px 10px;text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};">Product name</th>
          <th style="padding:7px 10px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};">Qty</th>
          <th style="padding:7px 10px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};white-space:nowrap;">Unit price</th>
          <th style="padding:7px 10px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};">Total</th>
        </tr>
      </thead>
      <tbody>${productRows || `<tr><td colspan="5" style="padding:14px 10px;font-size:12px;color:${MUTED};">No items selected.</td></tr>`}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="border-top:1.5px solid ${INK};"></td>
          <td style="border-top:1.5px solid ${INK};padding:10px;text-align:right;font-size:12px;font-weight:700;">Total</td>
          <td style="border-top:1.5px solid ${INK};padding:10px;text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;">${money(m.totalCostMinor)}</td>
        </tr>
      </tfoot>
    </table>
  </section>

  ${notes}

  ${block('Ship to address', labelRow('Organization', esc(m.shipTo.name)) + labelRow('Address', m.shipTo.lines.map(esc).join('<br>') || '&mdash;'))}

  ${block('Ship to address — point of contact', labelRow('Name', esc(m.contact.name) || '&mdash;') + labelRow('Phone number', esc(m.contact.phone) || '&mdash;'))}

  ${block(
    'Summit Sensory Gym representative — submission details',
    labelRow('Email', esc(m.submittedBy.email)) +
      labelRow("Today's Date", esc(m.submittedLabel)) +
      labelRow('Completed by', esc(m.submittedBy.name) || '&mdash;'),
  )}

  <section style="page-break-inside:avoid;border-top:1px solid ${RULE};padding-top:14px;font-size:12px;line-height:1.6;">
    <p style="margin:0 0 10px;">Upon review of our Freight Quote Request (RFQ), please submit all questions and quote details to ${esc(m.submittedBy.email)}.</p>
    <p style="margin:0;font-weight:700;">Communication with our client is strictly prohibited unless prior approval has been granted by Summit Sensory Gym.</p>
  </section>
</body>
</html>`;
}

/** Render straight from the id, for the preview route and the email attachment. */
export async function renderRfqHtml(rfqId: string): Promise<{ html: string; model: RfqModel }> {
  const model = await buildRfqModel(rfqId);
  return { html: renderRfqDocument(model), model };
}

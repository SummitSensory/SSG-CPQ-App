import { buildRfqModel, type RfqModel } from './freightRfq.js';
import { LOGO_DATA_URI, BRAND } from './brandLogo.js';

/**
 * The Request for Freight document.
 *
 * Self-contained HTML: inline styles, no external CSS and no webfonts, for the
 * same reason the BOM is built this way — the PDF renderer must not depend on
 * the network to produce a document a vendor is waiting on. The logo travels as
 * the data URI in brandLogo.ts, and headings use Georgia, which is what the
 * proposal's own print stylesheet substitutes for Newsreader anyway. So this
 * document and the proposal a customer holds read as one system: navy #203060
 * headings, red as the pointer, the same neutrals.
 *
 * Letter. The product table is full width and may break across pages; every
 * other section is kept whole.
 */

const B = BRAND;

/**
 * The address a freight desk should reply to. Deliberately a constant here and
 * not COMPANY.email or env.RFQ_REPLY_TO: COMPANY.email (Orders@) is what the BOM
 * and the finance documents print, and RFQ_REPLY_TO is the mailbox the send
 * routes through — this document asks vendors to write to sales@, so the printed
 * address is stated once, at the document, and does not move if either of those
 * changes.
 */
const RFQ_CONTACT_EMAIL = 'sales@summitsensory.com';

const money = (minor: number): string =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Post-nominals that belong on a name wherever it is printed outside the
 * building. The User record holds the legal name; the credential is a
 * presentation detail, kept here so it appears on this document the same way it
 * appears on the proposal front matter (public/intro-*.js) without editing the
 * account it came from. Keyed on the lowercased full name.
 */
const POST_NOMINALS: Record<string, string> = {
  'bryan shepherd': 'MBA',
};

/** "Bryan Shepherd" → "Bryan Shepherd, MBA". Unknown names pass through. */
function displayName(name: string): string {
  const clean = String(name ?? '').trim();
  if (!clean) return '';
  const suffix = POST_NOMINALS[clean.toLowerCase()];
  return suffix && !clean.toLowerCase().endsWith(suffix.toLowerCase())
    ? `${clean}, ${suffix}`
    : clean;
}

/**
 * A live mail link. Chromium's print-to-PDF keeps anchors, so the address is
 * clickable in the PDF a vendor opens as well as in the browser preview —
 * clicking it opens a new message already addressed.
 */
function mailto(email: string, opts: { color?: string; weight?: number } = {}): string {
  const clean = String(email ?? '').trim();
  if (!clean) return '&mdash;';
  const color = opts.color ?? B.navy;
  const weight = opts.weight ?? 600;
  return `<a href="mailto:${esc(clean)}" style="color:${color};font-weight:${weight};text-decoration:underline;text-underline-offset:2px;">${esc(clean)}</a>`;
}

/** Filesystem-safe basename: "RFQ-8050 R2 - Southpaw - Lynch Pediatric Therapy". */
export function rfqFilename(reference: string, vendor: string, customer = ''): string {
  return [reference, vendor, customer]
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One label/value pair inside a detail column. */
function detail(label: string, value: string): string {
  return `<div style="margin-top:7px;">
    <div style="font-size:7pt;text-transform:uppercase;letter-spacing:.1em;color:${B.muted};font-weight:700;">${esc(label)}</div>
    <div style="font-size:9.5pt;color:${B.ink};line-height:1.4;margin-top:1px;">${value}</div>
  </div>`;
}

/**
 * One of the three detail columns. They sit in a single row, divided by hairlines
 * rather than by whitespace: the ship-to, the person at that address and the
 * Summit rep behind the request are one set of facts, and stacking them as three
 * separate tables pushed them a third of a page apart.
 */
function column(title: string, rows: string, first = false): string {
  return `<div style="flex:1;padding:0 14px;${first ? '' : `border-left:1px solid ${B.navyRule};`}min-width:0;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:10pt;font-weight:700;color:${B.navy};letter-spacing:-.01em;line-height:1.2;">${esc(title)}</div>
    ${rows}
  </div>`;
}

const th = (label: string, align: 'left' | 'right'): string =>
  `<th style="padding:0 10px 5px;text-align:${align};font-size:7.5pt;text-transform:uppercase;letter-spacing:.08em;color:${B.muted};font-weight:700;border-bottom:1.5px solid ${B.navy};white-space:nowrap;">${esc(label)}</th>`;

export function renderRfqDocument(m: RfqModel): string {
  const included = m.lines.filter((l) => l.included);
  const rep = displayName(m.submittedBy.name);

  const productRows = included
    .map(
      (l, i) => `<tr style="background:${i % 2 ? B.navyTint : '#ffffff'};">
        <td style="padding:7px 10px;font-size:9pt;font-variant-numeric:tabular-nums;white-space:nowrap;color:${B.body};border-bottom:1px solid ${B.rule};">${esc(l.sku)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;color:${B.ink};border-bottom:1px solid ${B.rule};">${esc(l.name)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;border-bottom:1px solid ${B.rule};">${l.quantity}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;color:${B.body};border-bottom:1px solid ${B.rule};">${money(l.unitCostMinor)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;border-bottom:1px solid ${B.rule};">${money(l.extendedCostMinor)}</td>
      </tr>`,
    )
    .join('');

  const notes = m.notes
    ? `<section style="page-break-inside:avoid;margin:14px 0 0;padding:11px 13px;background:${B.navyTint};border-radius:9px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:10pt;font-weight:700;color:${B.navy};">Special Notes</div>
        <div style="font-size:9pt;color:${B.body};line-height:1.55;margin-top:4px;white-space:pre-wrap;">${esc(m.notes)}</div>
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(m.reference)}</title>
<style>
  @page { size: Letter; margin: 0.55in 0.6in 0.65in; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body { color:${B.ink}; font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  a { color:${B.navy}; }
</style>
</head>
<body>

  <header style="display:flex;justify-content:space-between;align-items:flex-start;gap:22px;padding-bottom:10px;border-bottom:2.5px solid ${B.navy};">
    <div style="display:flex;gap:11px;align-items:flex-start;">
      <img src="${LOGO_DATA_URI}" alt="Summit Sensory Gym" style="width:52px;height:52px;display:block;flex:none;">
      <div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14.5pt;font-weight:700;letter-spacing:-.01em;color:${B.navy};line-height:1.15;">${esc(m.company.name)}</div>
        <div style="font-size:7.5pt;color:${B.muted};line-height:1.55;margin-top:3px;">
          ${esc(m.company.addressLine1)}, ${esc(m.company.city)}, ${esc(m.company.region)} ${esc(m.company.postalCode)}<br>
          ${esc(m.company.phone)} &middot; ${mailto(RFQ_CONTACT_EMAIL, { color: B.muted, weight: 400 })}
        </div>
      </div>
    </div>
    <div style="text-align:right;flex:none;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:15pt;font-weight:700;line-height:1.1;white-space:nowrap;letter-spacing:-.01em;">
        <span style="color:${B.red};">Request</span> <span style="color:${B.navy};">for Freight</span>
      </div>
      <table style="border-collapse:collapse;font-size:8pt;margin-top:6px;margin-left:auto;">
        <tr>
          <td style="padding:1.5px 0;color:${B.muted};text-align:left;">Reference ID</td>
          <td style="padding:1.5px 0 1.5px 14px;text-align:right;font-weight:700;color:${B.navy};font-size:9pt;white-space:nowrap;">${esc(m.reference)}</td>
        </tr>
        <tr>
          <td style="padding:1.5px 0;color:${B.muted};text-align:left;">Vendor</td>
          <td style="padding:1.5px 0 1.5px 14px;text-align:right;font-weight:600;white-space:nowrap;">${esc(m.vendor)}</td>
        </tr>
        <tr>
          <td style="padding:1.5px 0;color:${B.muted};text-align:left;">Date</td>
          <td style="padding:1.5px 0 1.5px 14px;text-align:right;font-weight:600;white-space:nowrap;">${esc(m.todayLabel)}</td>
        </tr>
      </table>
    </div>
  </header>

  <section style="margin:16px 0 0;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:6px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;font-weight:700;color:${B.navy};letter-spacing:-.01em;">Items Requiring Freight</div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.1em;color:${B.muted};font-weight:700;">${included.length} item${included.length === 1 ? '' : 's'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>${th('SKU', 'left')}${th('Product Name', 'left')}${th('Qty', 'right')}${th('Unit Price', 'right')}${th('Total', 'right')}</tr>
      </thead>
      <tbody>${
        productRows ||
        `<tr><td colspan="5" style="padding:14px 10px;font-size:9.5pt;color:${B.muted};">No items selected.</td></tr>`
      }</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="border-top:1.5px solid ${B.navy};"></td>
          <td style="border-top:1.5px solid ${B.navy};padding:8px 10px;text-align:right;font-size:9.5pt;font-weight:700;color:${B.navy};white-space:nowrap;">Total</td>
          <td style="border-top:1.5px solid ${B.navy};padding:8px 10px;text-align:right;font-family:Georgia,'Times New Roman',serif;font-size:12pt;font-weight:700;color:${B.navy};font-variant-numeric:tabular-nums;">${money(m.totalCostMinor)}</td>
        </tr>
      </tfoot>
    </table>
  </section>

  <section style="page-break-inside:avoid;margin:14px 0 0;border:2px solid ${B.navy};border-radius:9px;overflow:hidden;">
    <div style="background:${B.red};color:#ffffff;padding:6px 13px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:12pt;font-weight:700;letter-spacing:.22em;text-transform:uppercase;">Important</div>
    <div style="padding:11px 13px;background:#ffffff;">
      <div style="font-size:8.5pt;font-weight:700;color:${B.navy};line-height:1.5;text-align:center;text-wrap:pretty;">
        Communication with our client is strictly prohibited unless prior approval has been granted by Summit Sensory Gym.
      </div>
    </div>
  </section>

  ${notes}

  <section style="page-break-inside:avoid;margin:16px 0 0;padding-top:12px;border-top:1px solid ${B.navyRule};">
    <div style="display:flex;align-items:flex-start;gap:0;margin:0 -14px;">
      ${column(
        'Ship To Address',
        detail('Organization', esc(m.shipTo.name) || '&mdash;') +
          detail('Address', m.shipTo.lines.map(esc).join('<br>') || '&mdash;'),
        true,
      )}
      ${column(
        'Point Of Contact',
        detail('Name', esc(displayName(m.contact.name)) || '&mdash;') +
          detail('Phone Number', esc(m.contact.phone) || '&mdash;'),
      )}
      ${column(
        'Summit Sensory Gym Representative',
        detail('Completed By', esc(rep) || '&mdash;') +
          detail('Email', mailto(RFQ_CONTACT_EMAIL)) +
          detail('Submitted', esc(m.submittedLabel)),
      )}
    </div>
  </section>

  <section style="page-break-inside:avoid;margin:16px 0 0;padding-top:10px;border-top:1px solid ${B.navyRule};font-size:9pt;line-height:1.6;color:${B.body};">
    Upon review of this Request for Freight, please submit all questions and quote details to
    ${mailto(RFQ_CONTACT_EMAIL)}.
  </section>

</body>
</html>`;
}

/** Render straight from the id, for the preview route and the email attachment. */
export async function renderRfqHtml(rfqId: string): Promise<{ html: string; model: RfqModel }> {
  const model = await buildRfqModel(rfqId);
  return { html: renderRfqDocument(model), model };
}

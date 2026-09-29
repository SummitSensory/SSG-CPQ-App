import { buildPurchaseOrderModel, type PurchaseOrderModel } from './purchaseOrder.js';
import { LOGO_DATA_URI, BRAND } from './brandLogo.js';
import {
  money,
  esc,
  displayName,
  mailto,
  detail,
  column,
  th,
  rfqFilename,
} from './freightRfqDocument.js';

/**
 * The Purchase Order document.
 *
 * Deliberately the Request for Freight's layout with purchasing language — same
 * header, same table, same IMPORTANT band, same three detail columns — so a vendor
 * who has quoted freight for us recognises the PO as the same company's paperwork.
 * Self-contained HTML for the same reason as the RFQ: the PDF renderer must not
 * depend on the network. What differs:
 *
 *   - the title, the reference label (PO Number) and payment terms in the header;
 *   - "Items Ordered", with a Subtotal, the Freight line and the Total;
 *   - the vendor's own part number under ours, where they number it differently;
 *   - replies go to the orders desk, as the Bill of Materials' do, not to sales.
 */

const B = BRAND;

/** "PO-12414494509-TFH - TFH Special Needs Toys - Miracles in Motion". */
export const purchaseOrderFilename = rfqFilename;

function freightCell(m: PurchaseOrderModel): string {
  if (m.noFreightCharge) return 'No charge';
  return m.freightMinor == null ? 'TBD' : money(m.freightMinor);
}

export function renderPurchaseOrderDocument(m: PurchaseOrderModel): string {
  const rep = displayName(m.orderedBy.name);
  const vendorCode = (sku: string, vendorSku: string) =>
    vendorSku && vendorSku !== sku
      ? `${esc(sku)}<div style="font-size:7.5pt;color:${B.muted};margin-top:1px;">Your #: ${esc(vendorSku)}</div>`
      : esc(sku);

  const productRows = m.lines
    .map(
      (l, i) => `<tr style="background:${i % 2 ? B.navyTint : '#ffffff'};">
        <td style="padding:7px 10px;font-size:9pt;font-variant-numeric:tabular-nums;white-space:nowrap;color:${B.body};border-bottom:1px solid ${B.rule};">${vendorCode(l.sku, l.vendorSku)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;color:${B.ink};border-bottom:1px solid ${B.rule};">${esc(l.name)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;border-bottom:1px solid ${B.rule};">${l.quantity}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;color:${B.body};border-bottom:1px solid ${B.rule};">${money(l.unitCostMinor)}</td>
        <td style="padding:7px 10px;font-size:9.5pt;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;border-bottom:1px solid ${B.rule};">${money(l.extendedCostMinor)}</td>
      </tr>`,
    )
    .join('');

  const totalRow = (label: string, value: string, strong = false, first = false) => `<tr>
      <td colspan="3" style="${first ? `border-top:1.5px solid ${B.navy};` : ''}"></td>
      <td style="${first ? `border-top:1.5px solid ${B.navy};` : ''}padding:${strong ? '8px' : '6px'} 10px 2px;text-align:right;font-size:9.5pt;font-weight:700;color:${strong ? B.navy : B.body};white-space:nowrap;">${esc(label)}</td>
      <td style="${first ? `border-top:1.5px solid ${B.navy};` : ''}padding:${strong ? '8px' : '6px'} 10px 2px;text-align:right;${strong ? `font-family:Georgia,'Times New Roman',serif;font-size:12pt;color:${B.navy};` : 'font-size:9.5pt;'}font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;">${value}</td>
    </tr>`;

  const notes = m.notes
    ? `<section style="page-break-inside:avoid;margin:14px 0 0;padding:11px 13px;background:${B.navyTint};border-radius:9px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:10pt;font-weight:700;color:${B.navy};">Special Notes</div>
        <div style="font-size:9pt;color:${B.body};line-height:1.55;margin-top:4px;white-space:pre-wrap;">${esc(m.notes)}</div>
      </section>`
    : '';

  const headerRow = (label: string, value: string, strong = false) =>
    value
      ? `<tr>
          <td style="padding:1.5px 0;color:${B.muted};text-align:left;">${esc(label)}</td>
          <td style="padding:1.5px 0 1.5px 14px;text-align:right;font-weight:${strong ? 700 : 600};${strong ? `color:${B.navy};font-size:9pt;` : ''}white-space:nowrap;">${esc(value)}</td>
        </tr>`
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
          ${esc(m.company.phone)} &middot; ${mailto(m.replyEmail, { color: B.muted, weight: 400 })}
        </div>
      </div>
    </div>
    <div style="text-align:right;flex:none;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:15pt;font-weight:700;line-height:1.1;white-space:nowrap;letter-spacing:-.01em;">
        <span style="color:${B.red};">Purchase</span> <span style="color:${B.navy};">Order</span>
      </div>
      <table style="border-collapse:collapse;font-size:8pt;margin-top:6px;margin-left:auto;">
        ${headerRow('PO Number', m.reference, true)}
        ${headerRow('Vendor', m.vendor)}
        ${headerRow('Date', m.todayLabel)}
        ${headerRow('Payment Terms', m.vendorBlock.paymentTerms)}
        ${headerRow('Our Account #', m.vendorBlock.accountNumber)}
      </table>
    </div>
  </header>

  <section style="margin:16px 0 0;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:6px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;font-weight:700;color:${B.navy};letter-spacing:-.01em;">Items Ordered</div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.1em;color:${B.muted};font-weight:700;">${m.lines.length} item${m.lines.length === 1 ? '' : 's'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>${th('SKU', 'left')}${th('Description', 'left')}${th('Qty', 'right')}${th('Unit Price', 'right')}${th('Total', 'right')}</tr>
      </thead>
      <tbody>${
        productRows ||
        `<tr><td colspan="5" style="padding:14px 10px;font-size:9.5pt;color:${B.muted};">No items selected.</td></tr>`
      }</tbody>
      <tfoot>
        ${totalRow('Subtotal', money(m.subtotalMinor), false, true)}
        ${totalRow('Shipping / Freight', freightCell(m))}
        ${totalRow('Total', money(m.totalMinor), true)}
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
        detail('Ordered By', esc(rep) || '&mdash;') +
          detail('Email', mailto(m.replyEmail)) +
          detail('Submitted', esc(m.submittedLabel)),
      )}
    </div>
  </section>

  <section style="page-break-inside:avoid;margin:16px 0 0;padding-top:10px;border-top:1px solid ${B.navyRule};font-size:9pt;line-height:1.6;color:${B.body};">
    Please confirm receipt of Purchase Order <b>${esc(m.reference)}</b> and your expected ship date, and send all questions and invoices to
    ${mailto(m.replyEmail)}. Please reference the PO number on your invoice and packing slip.
  </section>

</body>
</html>`;
}

/** Render straight from the id, for the preview route and the email attachment. */
export async function renderPurchaseOrderHtml(
  poId: string,
): Promise<{ html: string; model: PurchaseOrderModel }> {
  const model = await buildPurchaseOrderModel(poId);
  return { html: renderPurchaseOrderDocument(model), model };
}

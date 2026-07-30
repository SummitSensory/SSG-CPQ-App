import { buildBom, type BomDocument } from './bom.js';
import { prisma } from '../lib/prisma.js';

/**
 * The printed Bill of Materials, as self-contained HTML.
 *
 * This is the same document the browser's print dialog produces, moved to the
 * server so it can be attached to an email. It is deliberately one function with
 * no dependencies beyond the BOM data: inline styles only, no external CSS, no
 * images, no fonts to fetch. A renderer that reaches out to the network can hang
 * on a dead asset, and a vendor's document is the wrong place to discover that.
 */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (minor: number): string =>
  `$${(Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateOnly = (v: string | null): string => (v ? String(v).slice(0, 10) : '');

/** The questions and answers captured on a vendor's section, if any. */
async function sectionExtras(orderId: string, vendor: string) {
  const section = await prisma.bomVendorSection.findUnique({
    where: { orderId_vendor: { orderId, vendor } },
    include: { answers: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] } },
  });
  if (!section) return null;
  return {
    submittedOn: section.submittedOn ? section.submittedOn.toISOString() : null,
    deliveryType: section.deliveryType ?? '',
    shipmentQuote: section.shipmentQuote ?? '',
    notes: section.notes ?? '',
    jobName: section.jobName ?? '',
    status: section.status,
    answers: section.answers
      .map((a) => {
        let value = a.value ?? '';
        if (a.type === 'MULTI_SELECT' && value) {
          try {
            value = (JSON.parse(value) as string[]).join(', ');
          } catch {
            /* stored value is not JSON — print it as-is rather than losing it */
          }
        }
        return { label: a.label, value };
      })
      .filter((a) => a.value !== ''),
  };
}

const TH = 'padding:7px 8px;text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;color:#5c6157;border-bottom:1.5px solid #20241f;font-weight:600;';
const TD = 'padding:6px 8px;font-size:9pt;border-bottom:1px solid #e7e8e3;vertical-align:top;';

function addressBlock(title: string, lines: string[]): string {
  return `<div style="flex:1;min-width:0;">
    <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#8a8f85;margin-bottom:3px;font-weight:600;">${esc(title)}</div>
    <div style="font-size:9pt;line-height:1.45;">${lines.filter(Boolean).map(esc).join('<br>')}</div>
  </div>`;
}

/**
 * Render a BOM to a complete HTML document.
 *
 * `vendor` is a single vendor name, or '*' for every vendor combined. When it is
 * a single vendor and that vendor has a section, the section's own header and
 * question answers are used in place of the order-level defaults — the section is
 * the document of record.
 */
export async function renderBomHtml(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean } = {},
): Promise<{ html: string; doc: BomDocument }> {
  const doc = await buildBom(orderId, { vendor, includeZeroQty: opts.includeZeroQty });
  const all = vendor === '*';
  const extras = all ? null : await sectionExtras(orderId, vendor);

  const jobName = extras?.jobName || doc.order.jobName;
  const submittedOn = dateOnly(extras ? extras.submittedOn : doc.order.submittedOn);
  const deliveryType = extras?.deliveryType || doc.order.deliveryType;
  const shipmentQuote = extras?.shipmentQuote || doc.order.shipmentQuote;
  const notes = extras?.notes || doc.order.notes;

  const c = doc.company;
  const v = doc.vendor;

  const headCells = [
    ...(all ? ['Vendor'] : []),
    'Line #', 'Description', 'Qty', 'Powder color', 'Weight (lb)', 'Cost each', 'Total cost', 'Notes',
  ];

  const rows = doc.lines
    .map((l) => {
      const zero = l.quantity === 0;
      const cells = [
        ...(all ? [esc(l.vendor)] : []),
        `<code style="font-size:8.5pt;">${esc(l.lineNo)}</code>`,
        esc(l.name),
        String(l.quantity),
        esc(l.powderColor || '—'),
        String(l.extendedWeightLbs || 0),
        money(l.unitCostMinor),
        money(l.extendedCostMinor),
        esc(l.vendorNotes || ''),
      ];
      // A zero-quantity row is a blank order line, not an omission — greyed so the
      // shop can see it is there to be filled in.
      return `<tr${zero ? ' style="color:#9aa093;"' : ''}>${cells.map((x) => `<td style="${TD}">${x}</td>`).join('')}</tr>`;
    })
    .join('');

  const t = doc.totals;
  const totalCells = [
    ...(all ? [''] : []),
    '', '<b>Total</b>', `<b>${t.unitCount}</b>`, '', `<b>${t.totalWeightLbs}</b>`, '', `<b>${money(t.extendedCostMinor)}</b>`, '',
  ];

  const questionRows = (extras?.answers ?? [])
    .map(
      (a) => `<tr>
        <td style="padding:4px 10px 4px 0;font-size:9pt;color:#5c6157;white-space:nowrap;vertical-align:top;">${esc(a.label)}</td>
        <td style="padding:4px 0;font-size:9pt;font-weight:600;">${esc(a.value)}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Bill of Materials — ${esc(doc.order.number)}</title>
<style>
  @page { margin: 0.45in; }
  body { margin:0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:#20241f; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:12px;border-bottom:2px solid #20241f;">
    <div>
      <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;letter-spacing:-.01em;">${esc(c.name)}</div>
      <div style="font-size:8.5pt;color:#5c6157;line-height:1.45;margin-top:3px;">
        ${esc(c.addressLine1)}<br>${esc(c.city)}, ${esc(c.region)} ${esc(c.postalCode)}<br>${esc(c.phone)} · ${esc(c.email)}
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-family:Georgia,serif;font-size:14pt;font-weight:700;">Bill of Materials</div>
      <div style="font-size:8.5pt;color:#5c6157;margin-top:2px;">${esc(doc.order.number)} · accepted proposal v${esc(doc.order.acceptedVersion)}</div>
      <div style="font-size:8.5pt;color:#5c6157;">${esc(all ? 'All vendors' : vendor)}</div>
      ${extras?.status === 'SUBMITTED' ? '<div style="font-size:8pt;color:#2f6b4f;margin-top:3px;font-weight:600;">SUBMITTED</div>' : ''}
    </div>
  </div>

  <div style="display:flex;gap:24px;margin:14px 0 12px;">
    ${addressBlock('Ship from', v ? [v.name, v.addressLine1, v.addressLine2, [v.city, v.region, v.postalCode].filter(Boolean).join(', '), v.contactName, v.contactPhone, v.contactEmail] : ['All vendors'])}
    ${addressBlock('Ship to', [doc.shipTo.name, ...doc.shipTo.lines, doc.shipTo.contactName, doc.shipTo.phone])}
    ${addressBlock('Bill to', [doc.customer.name, doc.customer.addressLine1, doc.customer.addressLine2, [doc.customer.city, doc.customer.region, doc.customer.postalCode].filter(Boolean).join(', ')])}
  </div>

  <table style="width:100%;border-collapse:collapse;background:#fbfbf9;border:1px solid #e7e8e3;margin-bottom:14px;">
    <tr>
      <td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Job</span><br><b>${esc(jobName || '—')}</b></td>
      <td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Submission date</span><br><b>${esc(submittedOn || '—')}</b></td>
      <td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Delivery</span><br><b>${esc(deliveryType || '—')}</b></td>
      <td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Shipment quote</span><br><b>${esc(shipmentQuote || 'TBD')}</b></td>
      ${v?.accountNumber ? `<td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Account</span><br><b>${esc(v.accountNumber)}</b></td>` : ''}
      ${v?.paymentTerms ? `<td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">Terms</span><br><b>${esc(v.paymentTerms)}</b></td>` : ''}
    </tr>
  </table>

  ${questionRows ? `<table style="border-collapse:collapse;margin-bottom:14px;">${questionRows}</table>` : ''}

  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>${headCells.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows}
      <tr style="background:#f6f7f4;">${totalCells.map((x) => `<td style="${TD}border-bottom:none;">${x}</td>`).join('')}</tr>
    </tbody>
  </table>

  ${notes ? `<div style="margin-top:14px;padding:10px 12px;background:#fbfbf9;border:1px solid #e7e8e3;font-size:9pt;line-height:1.5;"><b style="font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Notes</b><br>${esc(notes).replace(/\n/g, '<br>')}</div>` : ''}

  <div style="margin-top:18px;font-size:8pt;color:#8a8f85;">
    Prepared ${esc(dateOnly(doc.createdAt))}${doc.createdBy ? ` by ${esc(doc.createdBy.name)}` : ''} · ${esc(c.name)}
  </div>
</body></html>`;

  return { html, doc };
}

/**
 * The same document as a spreadsheet. SpreadsheetML rather than real xlsx: it is
 * a single XML string with no zip step and no dependency, and Excel opens it
 * natively. The header block is written as rows above the table so a purchaser
 * can read the sheet without the covering email.
 */
export async function renderBomXml(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean } = {},
): Promise<string> {
  const doc = await buildBom(orderId, { vendor, includeZeroQty: opts.includeZeroQty });
  const all = vendor === '*';
  const extras = all ? null : await sectionExtras(orderId, vendor);

  const cell = (v: unknown, numeric = false): string =>
    `<Cell><Data ss:Type="${numeric ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`;
  const row = (cells: string[]): string => `<Row>${cells.join('')}</Row>`;

  const meta: string[] = [
    row([cell('Bill of Materials'), cell(doc.order.number)]),
    row([cell('Job'), cell(extras?.jobName || doc.order.jobName)]),
    row([cell('Vendor'), cell(all ? 'All vendors' : vendor)]),
    row([cell('Submission date'), cell(dateOnly(extras ? extras.submittedOn : doc.order.submittedOn))]),
    row([cell('Delivery type'), cell(extras?.deliveryType || doc.order.deliveryType)]),
    row([cell('Shipment quote'), cell(extras?.shipmentQuote || doc.order.shipmentQuote)]),
    ...(extras?.answers ?? []).map((a) => row([cell(a.label), cell(a.value)])),
    row([]),
  ];

  const head = row(
    [...(all ? ['Vendor'] : []), 'Line #', 'Description', 'Qty', 'Powder color', 'Weight (lb)', 'Cost each', 'Total cost', 'Notes', 'Status'].map((h) =>
      cell(h),
    ),
  );

  const body = doc.lines.map((l) =>
    row([
      ...(all ? [cell(l.vendor)] : []),
      cell(l.lineNo),
      cell(l.name),
      cell(l.quantity, true),
      cell(l.powderColor),
      cell(l.extendedWeightLbs, true),
      cell(l.unitCostMinor / 100, true),
      cell(l.extendedCostMinor / 100, true),
      cell(l.vendorNotes),
      cell(l.sourced ? 'Ordered' : 'Pending'),
    ]),
  );

  const t = doc.totals;
  const total = row([
    ...(all ? [cell('')] : []),
    cell('Total'),
    cell(''),
    cell(t.unitCount, true),
    cell(''),
    cell(t.totalWeightLbs, true),
    cell(''),
    cell(t.extendedCostMinor / 100, true),
    cell(''),
    cell(''),
  ]);

  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Bill of Materials"><Table>${meta.join('')}${head}${body.join('')}${total}</Table></Worksheet>
</Workbook>`;
}

/** Filesystem-safe basename for an attachment, e.g. `SO-1042-acme-steel`. */
export function bomFilename(orderNumber: string, vendor: string): string {
  const slug = (vendor === '*' ? 'all-vendors' : vendor)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${orderNumber}-${slug}`;
}

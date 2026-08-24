import { buildBom, streetLine, type BomDocument } from './bom.js';
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
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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
    showPowderColor: section.showPowderColor,
    showPackagingBag: section.showPackagingBag,
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

/**
 * The document's CONTENT, resolved once.
 *
 * The PDF and the spreadsheet were built by separate code, and separate code
 * drifts: the spreadsheet quietly lost the address blocks, the account and terms,
 * the vendor questions and the notes. Both renderers now consume this, so a field
 * added here appears in both or neither — they cannot disagree again.
 */
export interface BomModel {
  title: string;
  subtitle: string;
  vendorLabel: string;
  submitted: boolean;
  company: { name: string; lines: string[] };
  addresses: Array<{ title: string; lines: string[] }>;
  /** Job, submission date, delivery, quote, account, terms — label/value pairs. */
  meta: Array<{ label: string; value: string }>;
  questions: Array<{ label: string; value: string }>;
  columns: string[];
  /** Products in product-tree order, then a Hardware block. */
  groups: Array<{ title: string; rows: string[][] }>;
  totals: string[];
  /** What the sheet adds up to: items, freight, tax, grand total. */
  summary: Array<{ label: string; value: string; strong?: boolean }>;
  notes: string;
  footer: string;
  doc: BomDocument;
}

async function buildModel(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean; actorId?: string },
): Promise<BomModel> {
  const doc = await buildBom(orderId, {
    vendor,
    includeZeroQty: opts.includeZeroQty,
    actorId: opts.actorId,
  });
  const all = vendor === '*';
  const extras = all ? null : await sectionExtras(orderId, vendor);

  // A vendor section is the document of record once one exists; the order-level
  // header is only the default it was seeded from.
  const jobName = extras?.jobName || doc.order.jobName;
  // An unsubmitted section prints TODAY. It was printing an em dash, which on a
  // vendor's desk reads as "no date given" — the sheet is being sent today, so
  // today is the honest answer. Confirming the section is what persists it.
  const submittedOn =
    dateOnly(extras ? extras.submittedOn : doc.order.submittedOn) ||
    new Date().toISOString().slice(0, 10);
  const deliveryType = extras?.deliveryType || doc.order.deliveryType;
  const shipmentQuote = extras?.shipmentQuote || doc.order.shipmentQuote;
  const notes = extras?.notes || doc.order.notes;

  const c = doc.company;
  const v = doc.vendor;
  const t = doc.totals;

  const addr = (...parts: Array<string | undefined>) => parts.filter(Boolean).map(String);
  const cityLine = (city?: string, region?: string, postal?: string) =>
    [city, region, postal]
      .filter(Boolean)
      .join(', ')
      .replace(/, ([^,]*)$/, ' $1')
      .trim();

  const meta: Array<{ label: string; value: string }> = [
    { label: 'Job', value: jobName || '—' },
    { label: 'Submission date', value: submittedOn },
    { label: 'Delivery', value: deliveryType || '—' },
    { label: 'Shipment quote', value: shipmentQuote || 'TBD' },
  ];
  if (v?.accountNumber) meta.push({ label: 'Account', value: v.accountNumber });
  if (v?.paymentTerms) meta.push({ label: 'Terms', value: v.paymentTerms });
  if (v?.leadTimeDays != null) meta.push({ label: 'Lead time', value: `${v.leadTimeDays} days` });
  // Steel weight only means something when a steel fabricator is involved; on a
  // distributor's sheet it would always read 0 and invite the wrong conclusion.
  if (t.steelWeightLbs > 0)
    meta.push({ label: 'Total steel weight (lb)', value: t.steelWeightLbs.toFixed(2) });

  // The powder-colour column is opt-in per vendor. It was on every sheet, where for
  // most vendors it was a column of dashes; a section that has a colour on it keeps
  // the column regardless, so information is never dropped silently.
  const showColor = all
    ? doc.lines.some((l) => l.powderColor)
    : (extras?.showPowderColor ?? false) || doc.lines.some((l) => l.powderColor);

  // Packaging bag: opt-in per section the same way, and never printed when no part
  // on the sheet is bagged — about thirty hardware items carry one.
  const hasBag = doc.lines.some((l) => l.packagingBag);
  const showBag = hasBag && (all || (extras?.showPackagingBag ?? false));

  // Status and per-line Notes are gone. Status is our internal purchasing state and
  // means nothing to the vendor reading the sheet; Notes was a narrow column that
  // wrapped badly and pushed the table past the page. Any line note now reads in the
  // notes block at the bottom, prefixed with its part number, where it has room.
  // The vendor's own number for a part, where they number it differently to us
  // (the Adventure mats: our R-SSG-1010CLM is their A-3204). Printed beside our
  // number rather than instead of it — the shop and the vendor have to be able to
  // talk about the same line — and the column disappears when nothing on the sheet
  // is mapped.
  const showVendorPart = doc.lines.some((l) => (l.vendorSku || '').trim());

  const columns = [
    ...(all ? ['Vendor'] : []),
    'Part #',
    ...(showVendorPart ? ['Vendor part #'] : []),
    'Description',
    'Qty',
    ...(showBag ? ['Bag #'] : []),
    ...(showColor ? ['Powder color'] : []),
    'Weight (lb)',
    'Cost each',
    'Total cost',
  ];

  // Weight always carries two decimals. "12.5" and "12" on the same sheet read as
  // different precisions of measurement; freight is quoted on the total, so the
  // column has to add up visibly.
  const lbs = (n: number): string => (Number(n) || 0).toFixed(2);

  const rowOf = (l: (typeof doc.lines)[number]): string[] => [
    ...(all ? [l.vendor] : []),
    l.sku || l.lineNo,
    ...(showVendorPart ? [l.vendorSku || '—'] : []),
    l.name,
    String(l.quantity),
    ...(showBag ? [l.packagingBag || '—'] : []),
    ...(showColor ? [l.powderColor || '—'] : []),
    lbs(l.extendedWeightLbs),
    money(l.unitCostMinor),
    money(l.extendedCostMinor),
  ];

  // Two blocks: products in tree order, then hardware. Hardware last because it is
  // consumed last and because a hundred fasteners in the middle of the sheet buries
  // the parts the shop is actually looking for.
  const products = doc.lines.filter((l) => !l.isHardware);
  const hardware = doc.lines.filter((l) => l.isHardware);
  const groups: Array<{ title: string; rows: string[][] }> = [];
  if (products.length) groups.push({ title: '', rows: products.map(rowOf) });
  if (hardware.length) groups.push({ title: 'Hardware', rows: hardware.map(rowOf) });

  const totals = [
    ...(all ? [''] : []),
    '',
    ...(showVendorPart ? [''] : []),
    'Total',
    String(t.unitCount),
    ...(showBag ? [''] : []),
    ...(showColor ? [''] : []),
    lbs(t.totalWeightLbs),
    '',
    money(t.extendedCostMinor),
  ];

  // The money block. Freight and tax are quoted on the deal and typed as text, so
  // each prints as it reads; the grand total appears only when both are numbers,
  // because a total that quietly omits an unquoted freight is worse than none.
  const f = doc.financials;
  const summary: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: 'Item cost total', value: money(f.itemCostMinor) },
    {
      label: 'Estimated shipment total',
      value: f.shipmentMinor == null ? f.shipmentQuote || 'TBD' : money(f.shipmentMinor),
    },
  ];
  if (f.estimatedTax) {
    summary.push({
      label: 'Estimated tax',
      value: f.estimatedTaxMinor == null ? f.estimatedTax : money(f.estimatedTaxMinor),
    });
  }
  summary.push({
    label: 'Bill of Materials grand total',
    value: f.grandTotalMinor == null ? 'Pending freight' : money(f.grandTotalMinor),
    strong: true,
  });

  return {
    title: 'Bill of Materials',
    subtitle: `${doc.order.number} · accepted proposal v${doc.order.acceptedVersion}`,
    vendorLabel: all ? 'All vendors' : vendor,
    submitted: extras?.status === 'SUBMITTED',
    company: {
      name: c.name,
      lines: addr(
        c.addressLine1,
        cityLine(c.city, c.region, c.postalCode),
        [c.phone, c.email].filter(Boolean).join(' · '),
      ),
    },
    // Ship from / ship to only. Bill-to was removed: it repeated the ship-to block
    // verbatim on every sheet, and a vendor invoices Summit, never the customer —
    // printing the customer under "Bill to" on a purchase document is actively
    // misleading.
    addresses: [
      {
        title: 'Ship from',
        lines: v
          ? addr(
              v.name,
              streetLine(v.addressLine1, v.addressLine2),
              cityLine(v.city, v.region, v.postalCode),
              v.contactName,
              v.contactPhone,
              v.contactEmail,
            )
          : ['All vendors'],
      },
      {
        title: 'Ship to',
        lines: addr(
          doc.shipTo.name,
          ...doc.shipTo.lines,
          doc.shipTo.contactName,
          doc.shipTo.phone,
          doc.shipTo.email,
        ),
      },
    ],
    meta,
    questions: extras?.answers ?? [],
    columns,
    groups,
    totals,
    summary,
    // Line notes move here from their own column. Prefixed with the part number so a
    // note is still attached to something once it is out of the table.
    notes: [
      notes || '',
      ...doc.lines
        .filter((l) => (l.vendorNotes || '').trim())
        .map((l) => `${l.lineNo}: ${l.vendorNotes.trim()}`),
    ]
      .filter(Boolean)
      .join('\n'),
    footer: `Prepared ${dateOnly(doc.createdAt)}${doc.createdBy ? ` by ${doc.createdBy.name}` : ''} · ${c.name}`,
    doc,
  };
}

// One type size across the whole table — the same 8.5pt the Line # column already
// used. Body text at 9pt against an 8.5pt part number made the table look
// misaligned, and the two columns that were dropped bought back the width.
const TH =
  'padding:7px 8px;text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;color:#5c6157;border-bottom:1.5px solid #20241f;font-weight:600;';
const TD = 'padding:5px 8px;font-size:8.5pt;border-bottom:1px solid #e7e8e3;vertical-align:top;';

/**
 * Render a BOM to a complete HTML document, from the shared model.
 *
 * Self-contained: inline styles, no external CSS, no images, no fonts to fetch.
 * A renderer that reaches out to the network can hang on a dead asset, and a
 * vendor's document is the wrong place to discover that.
 */
export async function renderBomHtml(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean; actorId?: string } = {},
): Promise<{ html: string; doc: BomDocument }> {
  const m = await buildModel(orderId, vendor, opts);

  const addressBlock = (a: { title: string; lines: string[] }) => `<div style="flex:1;min-width:0;">
    <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#8a8f85;margin-bottom:3px;font-weight:600;">${esc(a.title)}</div>
    <div style="font-size:9pt;line-height:1.45;">${a.lines.map(esc).join('<br>')}</div>
  </div>`;

  const qtyIdx = m.columns.indexOf('Qty');
  const lineIdx = m.columns.indexOf('Line #');
  const rowTr = (cells: string[]): string => {
    // A zero-quantity row is a blank order line, not an omission — greyed so the
    // shop can see it is there to be filled in.
    const zero = cells[qtyIdx] === '0';
    return `<tr${zero ? ' style="color:#9aa093;"' : ''}>${cells
      .map((x, i) => `<td style="${TD}">${i === lineIdx ? `<code>${esc(x)}</code>` : esc(x)}</td>`)
      .join('')}</tr>`;
  };
  const rows = m.groups
    .map(
      (g) =>
        (g.title
          ? `<tr><td colspan="${m.columns.length}" style="padding:12px 8px 5px;font-size:8.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #20241f;">${esc(g.title)}</td></tr>`
          : '') + g.rows.map(rowTr).join(''),
    )
    .join('');

  const questionRows = m.questions
    .map(
      (a) => `<tr>
        <td style="padding:4px 10px 4px 0;font-size:9pt;color:#5c6157;white-space:nowrap;vertical-align:top;">${esc(a.label)}</td>
        <td style="padding:4px 0;font-size:9pt;font-weight:600;">${esc(a.value)}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>${esc(m.title)} — ${esc(m.doc.order.number)}</title>
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
      <div style="font-family:Georgia,serif;font-size:16pt;font-weight:700;letter-spacing:-.01em;">${esc(m.company.name)}</div>
      <div style="font-size:8.5pt;color:#5c6157;line-height:1.45;margin-top:3px;">${m.company.lines.map(esc).join('<br>')}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-family:Georgia,serif;font-size:14pt;font-weight:700;">${esc(m.title)}</div>
      <div style="font-size:8.5pt;color:#5c6157;margin-top:2px;">${esc(m.subtitle)}</div>
      <div style="font-size:8.5pt;color:#5c6157;">${esc(m.vendorLabel)}</div>
      ${m.submitted ? '<div style="font-size:8pt;color:#2f6b4f;margin-top:3px;font-weight:600;">SUBMITTED</div>' : ''}
    </div>
  </div>

  <div style="display:flex;gap:24px;margin:14px 0 12px;">${m.addresses.map(addressBlock).join('')}</div>

  <table style="width:100%;border-collapse:collapse;background:#fbfbf9;border:1px solid #e7e8e3;margin-bottom:14px;">
    <tr>${m.meta
      .map(
        (x) =>
          `<td style="padding:8px 10px;font-size:8.5pt;"><span style="color:#8a8f85;">${esc(x.label)}</span><br><b>${esc(x.value)}</b></td>`,
      )
      .join('')}</tr>
  </table>

  ${questionRows ? `<table style="border-collapse:collapse;margin-bottom:14px;">${questionRows}</table>` : ''}

  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>${m.columns.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows}
      <tr style="background:#f6f7f4;">${m.totals.map((x) => `<td style="${TD}border-bottom:none;font-weight:700;">${esc(x)}</td>`).join('')}</tr>
    </tbody>
  </table>

  <table style="margin-top:12px;margin-left:auto;border-collapse:collapse;font-size:8.5pt;">
    ${m.summary.map((r) => `<tr><td style="padding:4px 14px 4px 0;color:#5c6157;${r.strong ? 'font-weight:700;color:#20241f;border-top:1px solid #cfd2c9;' : ''}">${esc(r.label)}</td><td style="padding:4px 0;text-align:right;font-weight:${r.strong ? '700' : '600'};${r.strong ? 'border-top:1px solid #cfd2c9;' : ''}">${esc(r.value)}</td></tr>`).join('')}
  </table>

  ${m.notes ? `<div style="margin-top:14px;padding:10px 12px;background:#fbfbf9;border:1px solid #e7e8e3;font-size:9pt;line-height:1.5;"><b style="font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Notes</b><br>${esc(m.notes).replace(/\n/g, '<br>')}</div>` : ''}

  <div style="margin-top:18px;font-size:8pt;color:#8a8f85;">${esc(m.footer)}</div>
</body></html>`;

  return { html, doc: m.doc };
}

/**
 * The same document as a spreadsheet — same model, so it carries the same header
 * blocks, addresses, questions, lines, totals and notes as the PDF.
 *
 * SpreadsheetML rather than real xlsx: it is a single XML string with no zip step
 * and no dependency, and Excel opens it natively.
 */
export async function renderBomXml(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean; actorId?: string } = {},
): Promise<string> {
  const m = await buildModel(orderId, vendor, opts);

  // Money and quantities are written as text, exactly as the PDF prints them.
  // Excel would otherwise reformat "$1,212.50" to its own locale and the two
  // documents would no longer read the same.
  const cell = (v: unknown, style?: string): string =>
    `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  const row = (cells: string[]): string => `<Row>${cells.join('')}</Row>`;
  const blank = row([]);
  const heading = (text: string) => row([cell(text, 'h')]);

  const body: string[] = [];

  body.push(row([cell(m.title, 'title'), cell(m.doc.order.number, 'b')]));
  body.push(row([cell(m.subtitle)]));
  body.push(row([cell('Vendor', 'lbl'), cell(m.vendorLabel, 'b')]));
  if (m.submitted) body.push(row([cell('Status', 'lbl'), cell('SUBMITTED', 'b')]));
  body.push(blank);

  body.push(row([cell(m.company.name, 'b')]));
  m.company.lines.forEach((l) => body.push(row([cell(l)])));
  body.push(blank);

  // Addresses side by side, as they appear on the PDF, rather than stacked — the
  // sheet should be recognisable as the same document.
  const depth = Math.max(...m.addresses.map((a) => a.lines.length), 0);
  body.push(row(m.addresses.map((a) => cell(a.title, 'lbl'))));
  for (let i = 0; i < depth; i++) body.push(row(m.addresses.map((a) => cell(a.lines[i] ?? ''))));
  body.push(blank);

  m.meta.forEach((x) => body.push(row([cell(x.label, 'lbl'), cell(x.value, 'b')])));
  body.push(blank);

  if (m.questions.length) {
    body.push(heading('Vendor questions'));
    m.questions.forEach((q) => body.push(row([cell(q.label, 'lbl'), cell(q.value, 'b')])));
    body.push(blank);
  }

  body.push(row(m.columns.map((h) => cell(h, 'th'))));
  m.groups.forEach((g) => {
    if (g.title) body.push(row([cell(g.title, 'h')]));
    g.rows.forEach((r) => body.push(row(r.map((v) => cell(v)))));
  });
  body.push(row(m.totals.map((v) => cell(v, 'b'))));
  // The money block, under the table.
  body.push(row([]));
  for (const line of m.summary) {
    body.push(row([cell(line.label, line.strong ? 'b' : undefined), cell(line.value, 'b')]));
  }

  if (m.notes) {
    body.push(blank);
    body.push(heading('Notes'));
    m.notes.split('\n').forEach((line) => body.push(row([cell(line)])));
  }

  body.push(blank);
  body.push(row([cell(m.footer)]));

  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="title"><Font ss:Bold="1" ss:Size="14"/></Style>
  <Style ss:ID="h"><Font ss:Bold="1" ss:Size="11"/></Style>
  <Style ss:ID="th"><Font ss:Bold="1"/><Interior ss:Color="#F2F3EF" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2"/></Borders></Style>
  <Style ss:ID="lbl"><Font ss:Color="#5C6157"/></Style>
  <Style ss:ID="b"><Font ss:Bold="1"/></Style>
</Styles>
<Worksheet ss:Name="Bill of Materials"><Table>${body.join('')}</Table></Worksheet>
</Workbook>`;
}

/**
 * Attachment basename: `Customer_Name-Order_Number-Vendor_Name`.
 *
 * Customer first because that is how a vendor's inbox gets searched — they hold
 * jobs for several of our customers and know ours by name, not by our order
 * numbering. Spaces become underscores and separators become hyphens, so the two
 * levels stay readable apart; anything a filesystem or mail client would object to
 * is dropped.
 */
export function bomFilename(orderNumber: string, vendor: string, customerName = ''): string {
  const part = (v: string) =>
    v
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/[\s]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  return [part(customerName), part(orderNumber), part(vendor === '*' ? 'All Vendors' : vendor)]
    .filter(Boolean)
    .join('-');
}

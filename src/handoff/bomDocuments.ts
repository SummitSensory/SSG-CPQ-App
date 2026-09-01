import ExcelJS from 'exceljs';
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
 * One table cell, carrying enough to render in either a document with laid-out
 * text (the PDF, the CSV) or a real spreadsheet that has to sum and format its own
 * numbers.
 *
 * `text` is what the PDF, the on-screen table and the CSV print — pre-formatted
 * exactly as it always was ("$1,234.56", "12.50"), unchanged by this shape. A cell
 * that IS a real number for Excel's purposes carries `numericValue` and `numFmt`
 * alongside it; `renderBomXlsx` writes those so the column can be summed and reads
 * as currency, while every other renderer keeps reading `text` and never has to
 * know a numeric cell exists.
 *
 * `bold` and `align` are extensibility, not policy: nothing in `buildModel` sets
 * `bold` today — no line or column is flagged that way — but a caller (or a later
 * per-vendor preference) can mark specific cells without editing `renderBomXlsx`,
 * which applies whatever the model marks and decides nothing on its own beyond its
 * own structural defaults (the header row, the totals row, the title).
 */
export interface BomCell {
  text: string;
  numericValue?: number;
  numFmt?: string;
  align?: 'left' | 'right';
  bold?: boolean;
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
  /**
   * The part rows, in proposal order — no other organising principle. A single
   * group with an empty title unless something someday needs more than one; kept
   * as groups (rather than a flat row list) so that later "someday" costs nothing
   * to add.
   */
  groups: Array<{ title: string; rows: BomCell[][] }>;
  totals: BomCell[];
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

  const text = (v: string): BomCell => ({ text: v });
  // A numeric column carries its own formatted text (unchanged for the PDF/CSV)
  // alongside the real number and format Excel needs to write a summable cell.
  const numeric = (formatted: string, value: number, numFmt: string): BomCell => ({
    text: formatted,
    numericValue: value,
    numFmt,
    align: 'right',
  });

  const rowOf = (l: (typeof doc.lines)[number]): BomCell[] => [
    ...(all ? [text(l.vendor)] : []),
    text(l.sku || l.lineNo),
    ...(showVendorPart ? [text(l.vendorSku || '—')] : []),
    text(l.name),
    numeric(String(l.quantity), l.quantity, '0'),
    ...(showBag ? [text(l.packagingBag || '—')] : []),
    ...(showColor ? [text(l.powderColor || '—')] : []),
    numeric(lbs(l.extendedWeightLbs), l.extendedWeightLbs, '#,##0.00'),
    numeric(money(l.unitCostMinor), l.unitCostMinor / 100, '$#,##0.00'),
    numeric(money(l.extendedCostMinor), l.extendedCostMinor / 100, '$#,##0.00'),
  ];

  // One group, in proposal order — no other organising principle. Hardware used to
  // collect in a trailing block of its own; it now prints wherever it falls, which
  // for a kit's exploded fasteners is the position the kit itself held on the
  // proposal (see proposalLineOrder in bom.ts).
  const groups: Array<{ title: string; rows: BomCell[][] }> = doc.lines.length
    ? [{ title: '', rows: doc.lines.map(rowOf) }]
    : [];

  const totals: BomCell[] = [
    ...(all ? [text('')] : []),
    text(''),
    ...(showVendorPart ? [text('')] : []),
    text('Total'),
    numeric(String(t.unitCount), t.unitCount, '0'),
    ...(showBag ? [text('')] : []),
    ...(showColor ? [text('')] : []),
    numeric(lbs(t.totalWeightLbs), t.totalWeightLbs, '#,##0.00'),
    text(''),
    numeric(money(t.extendedCostMinor), t.extendedCostMinor / 100, '$#,##0.00'),
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
  const rowTr = (cells: BomCell[]): string => {
    // A zero-quantity row is a blank order line, not an omission — greyed so the
    // shop can see it is there to be filled in.
    const zero = cells[qtyIdx]?.text === '0';
    return `<tr${zero ? ' style="color:#9aa093;"' : ''}>${cells
      .map(
        (x, i) =>
          `<td style="${TD}">${i === lineIdx ? `<code>${esc(x.text)}</code>` : esc(x.text)}</td>`,
      )
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
      <tr style="background:#f6f7f4;">${m.totals.map((x) => `<td style="${TD}border-bottom:none;font-weight:700;">${esc(x.text)}</td>`).join('')}</tr>
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

const HEADER_FILL = 'FFF2F3EF';
const LABEL_ARGB = 'FF5C6157';

/**
 * The same document as a real .xlsx workbook — same model, so it carries the same
 * header blocks, addresses, questions, lines, totals and notes as the PDF.
 *
 * Replaces the old SpreadsheetML `.xls` export: that format could not set column
 * widths, and its extension/MIME mismatch is what triggered Excel's "possible data
 * loss" warning. This is a real workbook exceljs writes as a zip, so Excel opens it
 * cleanly, sums its numeric columns, and never wraps a cell.
 */
export async function renderBomXlsx(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean; actorId?: string } = {},
): Promise<{ buffer: Buffer; doc: BomDocument }> {
  const m = await buildModel(orderId, vendor, opts);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Bill of Materials');

  // Widest rendered string seen in each column, tracked as it is written rather
  // than re-read off the cell afterward — a numeric cell's own VALUE is shorter
  // than what actually prints ("4190.22" vs "$4,190.22"), and this is the width
  // that has to fit the column.
  const colWidths: number[] = [];
  const track = (col: number, text: string) => {
    colWidths[col - 1] = Math.max(colWidths[col - 1] ?? 0, text.length);
  };
  const plainRow = (cells: string[]): ExcelJS.Row => {
    const row = sheet.addRow(cells);
    cells.forEach((c, i) => track(i + 1, c));
    return row;
  };
  const label = (r: ExcelJS.Row, col: number) => {
    r.getCell(col).font = { color: { argb: LABEL_ARGB } };
  };
  const bold = (r: ExcelJS.Row, col: number) => {
    r.getCell(col).font = { ...(r.getCell(col).font ?? {}), bold: true };
  };
  // Every cell gets an explicit alignment, left unless told otherwise: nothing is
  // allowed to wrap, which is the whole point of computing widths at all.
  const noWrap = (r: ExcelJS.Row, col: number, align: 'left' | 'right' = 'left') => {
    r.getCell(col).alignment = { horizontal: align, wrapText: false };
  };
  const noWrapRow = (r: ExcelJS.Row) => r.eachCell((c) => (c.alignment = { wrapText: false }));

  const titleRow = plainRow([m.title, m.doc.order.number]);
  titleRow.font = { bold: true, size: 14 };
  noWrapRow(titleRow);

  noWrapRow(plainRow([m.subtitle]));
  const vendorRow = plainRow(['Vendor', m.vendorLabel]);
  label(vendorRow, 1);
  bold(vendorRow, 2);
  noWrapRow(vendorRow);
  if (m.submitted) {
    const statusRow = plainRow(['Status', 'SUBMITTED']);
    label(statusRow, 1);
    bold(statusRow, 2);
    noWrapRow(statusRow);
  }
  plainRow([]);

  const companyRow = plainRow([m.company.name]);
  bold(companyRow, 1);
  noWrapRow(companyRow);
  m.company.lines.forEach((l) => noWrapRow(plainRow([l])));
  plainRow([]);

  // Addresses side by side, as on the PDF, rather than stacked — the sheet should
  // be recognisable as the same document.
  const addrTitleRow = plainRow(m.addresses.map((a) => a.title));
  m.addresses.forEach((_a, i) => label(addrTitleRow, i + 1));
  noWrapRow(addrTitleRow);
  const depth = Math.max(...m.addresses.map((a) => a.lines.length), 0);
  for (let i = 0; i < depth; i++) {
    noWrapRow(plainRow(m.addresses.map((a) => a.lines[i] ?? '')));
  }
  plainRow([]);

  // Meta block: label cells in the muted grey the PDF's `lbl` style already uses,
  // value cells bold — one pair per row, which reads more naturally in a
  // spreadsheet than the PDF's side-by-side card layout.
  m.meta.forEach((x) => {
    const r = plainRow([x.label, x.value]);
    label(r, 1);
    bold(r, 2);
    noWrapRow(r);
  });
  plainRow([]);

  if (m.questions.length) {
    const h = plainRow(['Vendor questions']);
    bold(h, 1);
    noWrapRow(h);
    m.questions.forEach((q) => {
      const r = plainRow([q.label, q.value]);
      label(r, 1);
      bold(r, 2);
      noWrapRow(r);
    });
    plainRow([]);
  }

  // The table itself. Header row bold, thick rule under it, light fill — and this
  // is where freeze panes lock, so the header stays visible under a long BOM.
  const headerRow = plainRow(m.columns);
  headerRow.eachCell((c) => {
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.border = { bottom: { style: 'medium' } };
    c.alignment = { wrapText: false };
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];

  const writeCell = (r: ExcelJS.Row, col: number, bc: BomCell) => {
    const cell = r.getCell(col);
    cell.value = bc.numericValue != null ? bc.numericValue : bc.text;
    if (bc.numFmt) cell.numFmt = bc.numFmt;
    cell.alignment = { horizontal: bc.align === 'right' ? 'right' : 'left', wrapText: false };
    if (bc.bold) cell.font = { ...(cell.font ?? {}), bold: true };
    track(col, bc.text);
  };

  m.groups.forEach((g) => {
    if (g.title) {
      const h = sheet.addRow([g.title]);
      bold(h, 1);
      noWrapRow(h);
      track(1, g.title);
    }
    g.rows.forEach((cells) => {
      const r = sheet.addRow([]);
      cells.forEach((bc, i) => writeCell(r, i + 1, bc));
    });
  });

  // Totals row: bold, with a top border, over the same columns as the table above.
  const totalsRow = sheet.addRow([]);
  m.totals.forEach((bc, i) => writeCell(totalsRow, i + 1, bc));
  totalsRow.eachCell((c) => {
    c.font = { ...(c.font ?? {}), bold: true };
    c.border = { top: { style: 'thin' } };
  });

  plainRow([]);
  m.summary.forEach((line) => {
    const r = plainRow([line.label, line.value]);
    noWrap(r, 2, 'right');
    if (line.strong) {
      r.eachCell((c) => {
        c.font = { ...(c.font ?? {}), bold: true };
        c.border = { top: { style: 'thin' } };
      });
    }
  });

  if (m.notes) {
    plainRow([]);
    const h = plainRow(['Notes']);
    bold(h, 1);
    noWrapRow(h);
    m.notes.split('\n').forEach((line) => noWrapRow(plainRow([line])));
  }

  plainRow([]);
  noWrapRow(plainRow([m.footer]));

  // Auto-fit: exceljs has no such feature, so this is the longest rendered string
  // seen in each column, capped so one runaway note cannot blow out the sheet.
  // Description is the one column that should go wide rather than truncate, and
  // capping at 60 rather than, say, 40 gives it the room to.
  colWidths.forEach((len, i) => {
    sheet.getColumn(i + 1).width = Math.min(len + 2, 60);
  });

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, doc: m.doc };
}

/**
 * The same document as a CSV — same model, so unlike the old browser-built CSV it
 * carries the addresses, the vendor questions and the notes alongside the lines.
 *
 * Kept alongside the xlsx for the rep who wants to paste the numbers into
 * something else rather than open a workbook.
 */
export async function renderBomCsv(
  orderId: string,
  vendor: string,
  opts: { includeZeroQty?: boolean; actorId?: string } = {},
): Promise<{ csv: string; doc: BomDocument }> {
  const m = await buildModel(orderId, vendor, opts);

  const field = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const row = (cells: string[]): string => cells.map(field).join(',');
  const rows: string[] = [];

  rows.push(row([m.title, m.doc.order.number]));
  rows.push(row([m.subtitle]));
  rows.push(row(['Vendor', m.vendorLabel]));
  if (m.submitted) rows.push(row(['Status', 'SUBMITTED']));
  rows.push('');

  rows.push(row([m.company.name]));
  m.company.lines.forEach((l) => rows.push(row([l])));
  rows.push('');

  const depth = Math.max(...m.addresses.map((a) => a.lines.length), 0);
  rows.push(row(m.addresses.map((a) => a.title)));
  for (let i = 0; i < depth; i++) rows.push(row(m.addresses.map((a) => a.lines[i] ?? '')));
  rows.push('');

  m.meta.forEach((x) => rows.push(row([x.label, x.value])));
  rows.push('');

  if (m.questions.length) {
    rows.push(row(['Vendor questions']));
    m.questions.forEach((q) => rows.push(row([q.label, q.value])));
    rows.push('');
  }

  rows.push(row(m.columns));
  m.groups.forEach((g) => {
    if (g.title) rows.push(row([g.title]));
    g.rows.forEach((cells) => rows.push(row(cells.map((c) => c.text))));
  });
  rows.push(row(m.totals.map((c) => c.text)));
  rows.push('');

  m.summary.forEach((line) => rows.push(row([line.label, line.value])));

  if (m.notes) {
    rows.push('');
    rows.push(row(['Notes']));
    m.notes.split('\n').forEach((line) => rows.push(row([line])));
  }

  rows.push('');
  rows.push(row([m.footer]));

  // The UTF-8 BOM keeps Excel from mangling the em dash in the Ship-to line.
  return { csv: '\ufeff' + rows.join('\n'), doc: m.doc };
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

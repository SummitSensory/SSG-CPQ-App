import { renderPdf } from '../render/pdf.js';
import { LOGO_DATA_URI, BRAND } from '../handoff/brandLogo.js';
// The same allow-list that cleans a pasted email signature. A payment letter is
// HTML somebody types into an admin screen and it ends up both in a customer's
// inbox and in a rendered PDF, so it gets exactly the same treatment: presentation
// tags survive, scripts, styles, iframes, event handlers and odd URL schemes do not.
import { sanitizeSignature } from '../routes/outlook.js';

/**
 * Payment-request emails and letterhead letters.
 *
 * Three things live here and nothing else: the merge fields, the HTML the customer
 * receives, and the letterhead the attached letter is printed on.
 *
 * Merge fields are `{{snake_case}}`. Deliberately not a template language — no
 * conditionals, no loops, no expressions. Everything a letter needs to say is
 * either a figure from the invoice or a date the sender types in, and a language
 * with logic in it is a language somebody eventually debugs at five o'clock on a
 * Friday while a customer waits for their statement.
 *
 * An unresolved field renders as nothing AND is reported back to the composer, so
 * a letter that would have gone out reading "your balance of  is now due" is
 * refused before it is sent rather than after.
 */

export const TEMPLATE_KINDS = ['EMAIL', 'LETTER'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Every field a template may use, in the order the reference list shows them.
 *
 * `entered` marks the three that come from the person sending, not from the
 * database: a tentative ship date and the deadlines being offered are commercial
 * decisions made per message, and inventing them from a due date would put a
 * commitment in front of a customer that nobody made.
 */
export const MERGE_FIELDS: Array<{ token: string; means: string; entered?: boolean }> = [
  { token: 'customer_first_name', means: 'The recipient’s first name' },
  { token: 'customer_name', means: 'The recipient’s full name' },
  { token: 'organization_name', means: 'The customer’s organization' },
  { token: 'invoice_number', means: 'QuickBooks invoice number' },
  { token: 'invoice_date', means: 'The date the invoice was issued' },
  { token: 'invoice_amount', means: 'The invoice total as originally issued' },
  { token: 'invoice_link', means: 'QuickBooks payment link, when the company has one' },
  { token: 'balance_due', means: 'Outstanding now' },
  { token: 'amount_paid', means: 'Received against this invoice so far' },
  { token: 'due_date', means: 'The invoice due date' },
  { token: 'days_past_due', means: 'Whole days past due, or 0' },
  { token: 'po_number', means: 'The customer’s purchase-order number' },
  { token: 'order_number', means: 'Summit order number' },
  { token: 'proposal_number', means: 'The accepted proposal' },
  { token: 'sender_name', means: 'You' },
  { token: 'sender_title', means: 'Your title' },
  { token: 'sender_email', means: 'Your email address' },
  { token: 'sender_phone', means: 'Your phone number' },
  { token: 'today', means: 'Today’s date' },
  { token: 'tentative_ship_date', means: 'Typed in when you send', entered: true },
  { token: 'payment_deadline', means: 'Typed in when you send', entered: true },
  { token: 'final_payment_deadline', means: 'Typed in when you send', entered: true },
];

export const ENTERED_FIELDS = MERGE_FIELDS.filter((f) => f.entered).map((f) => f.token);

export type MergeValues = Record<string, string>;

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/** `$1,234.56`, from minor units. */
export function money(
  minor: bigint | number | string | null | undefined,
  currency = 'USD',
): string {
  if (minor == null) return '';
  const n = Number(minor) / 100;
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency });
}

/** `March 4, 2026`. Formatted in UTC so a yyyy-mm-dd never slips a day. */
export function longDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d =
    typeof value === 'string'
      ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
      : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Which fields a template actually uses. Drives the composer's warnings. */
export function tokensIn(template: string): string[] {
  const found = new Set<string>();
  for (const m of String(template ?? '').matchAll(TOKEN_RE)) found.add(m[1]!.toLowerCase());
  return [...found];
}

export interface RenderResult {
  html: string;
  /** Tokens the template used that resolved to nothing. */
  missing: string[];
  /** Tokens the template used that are not merge fields at all — a typo. */
  unknown: string[];
}

/**
 * Substitute the merge fields.
 *
 * Values are escaped, with one exception: `invoice_link` becomes a real anchor,
 * because a payment link the customer has to copy out of the text of an email is a
 * payment link that does not get used. It is escaped as an attribute and only
 * emitted when it is an http(s) URL, so a stored value that is not one cannot
 * become markup.
 */
export function renderTemplate(template: string, values: MergeValues): RenderResult {
  const known = new Set(MERGE_FIELDS.map((f) => f.token));
  const missing: string[] = [];
  const unknown: string[] = [];

  const html = String(template ?? '').replace(TOKEN_RE, (_all, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!known.has(name)) {
      unknown.push(name);
      return '';
    }
    const value = String(values[name] ?? '').trim();
    if (!value) {
      // days_past_due is legitimately "0" and po_number is legitimately absent on
      // a customer who never issues one — neither is a hole in the letter.
      if (name !== 'days_past_due' && name !== 'po_number') missing.push(name);
      return '';
    }
    if (name === 'invoice_link') {
      if (!/^https?:\/\//i.test(value)) return '';
      return `<a href="${esc(value)}" style="color:#3d4a55;">${esc(value)}</a>`;
    }
    return esc(value);
  });

  return { html, missing: [...new Set(missing)], unknown: [...new Set(unknown)] };
}

/* ------------------------------------------------------------------ the email */

/**
 * Wrap a rendered body in the email shell.
 *
 * Deliberately plain: no logo band, no buttons, no table layout. This is a
 * one-to-one message from a person about money, and it has to read as one — an
 * invoice chase that looks like a marketing blast gets filed as one, and the
 * signature appended below it is a real Outlook signature that would sit oddly
 * under a branded header. The only thing the shell buys is a readable measure and
 * correct paragraph spacing in Outlook, which ignores most of what it is given.
 */
export function emailShell(bodyHtml: string): string {
  return (
    '<div style="font-family:Calibri,\'Segoe UI\',Arial,sans-serif;font-size:11pt;color:#20241f;line-height:1.5;max-width:660px;">' +
    bodyHtml +
    '</div>'
  );
}

/** A figures block both the built-in email and any letter can lift verbatim. */
export function figuresTable(values: MergeValues): string {
  // Declared, then filtered. The tuple annotation does not survive a chained
  // .filter() — TypeScript widens the literal to string[][] before the contextual
  // type is applied — so the two steps are deliberately separate.
  const all: Array<[string, string]> = [
    ['Invoice', values.invoice_number ?? ''],
    ['Invoice date', values.invoice_date ?? ''],
    ['Invoice amount', values.invoice_amount ?? ''],
    ['Received', values.amount_paid ?? ''],
    ['Balance due', values.balance_due ?? ''],
    ['Due date', values.due_date ?? ''],
    ['Purchase order', values.po_number ?? ''],
  ];
  const rows = all.filter(([, v]) => String(v).trim());

  return (
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14pt 0;font-size:11pt;">' +
    rows
      .map(
        ([label, value], i) =>
          '<tr>' +
          `<td style="padding:4pt 18pt 4pt 0;color:#5c6357;${i === rows.length - 1 ? '' : ''}">${esc(label)}</td>` +
          `<td style="padding:4pt 0;font-weight:${label === 'Balance due' ? '700' : '400'};">${esc(String(value))}</td>` +
          '</tr>',
      )
      .join('') +
    '</table>'
  );
}

/**
 * The email that ships with the app, so the feature works the first time it is
 * opened rather than after somebody writes a template.
 *
 * Written plainly and without pressure. A first request is usually a forwarding
 * problem inside the customer's own accounts payable, not a refusal to pay, and
 * the tone that gets it paid is the one that assumes so. Editable under
 * Administration → Payment requests like everything else; this copy is only the
 * starting point.
 */
export const DEFAULT_EMAIL_TEMPLATE = {
  key: 'balance-due',
  kind: 'EMAIL' as TemplateKind,
  name: 'Outstanding balance',
  stage: 1,
  whenToUse: 'A balance is outstanding and you want the customer to arrange payment.',
  subject: 'Summit Sensory Gym | Invoice {{invoice_number}} — {{balance_due}} outstanding',
  bodyHtml: [
    '<p>Hello {{customer_first_name}},</p>',
    '<p>I am writing about invoice {{invoice_number}} for {{organization_name}}, which has a balance of <b>{{balance_due}}</b> outstanding.</p>',
    '<p>{{FIGURES}}</p>',
    '<p>The invoice can be paid using the link on it, or by check to the address it shows. If it has already gone out for payment, or if it needs to reach someone else in your accounts payable, let me know and I will send it straight to them.</p>',
    '<p>Please let me know if anything on the invoice needs explaining.</p>',
    '<p>Thank you,</p>',
  ].join('\n'),
};

/**
 * `{{FIGURES}}` is the one non-field placeholder: it drops in the figures table
 * above. Kept out of MERGE_FIELDS because it is a block, not a value, and letting
 * it into the field list would put it in the reference table as though it were one.
 */
export function expandFigures(html: string, values: MergeValues): string {
  return String(html ?? '').replace(/\{\{\s*FIGURES\s*\}\}/g, () => figuresTable(values));
}

/* ----------------------------------------------------------------- the letter */

export interface LetterheadInput {
  /** The letter's heading, from the template's subject. */
  title: string;
  /** Rendered, sanitised body HTML. */
  bodyHtml: string;
  /** Who it is addressed to, printed as an address block. */
  addressee: string[];
  /** The sender's own block, printed under the sign-off. */
  sender: { name: string; title?: string | null; email?: string | null; phone?: string | null };
  dateLine: string;
}

/**
 * The letter, as a complete self-contained HTML document for the PDF renderer.
 *
 * Self-contained is a hard requirement, not a style: renderPdf runs headless
 * Chromium with no network access, so the mark travels as the data URI in
 * brandLogo.ts. An `<img src>` pointing at the app would print a broken image on a
 * document a customer receives.
 *
 * The letterhead is the one the freight RFQ and the Ryan Capital financing sheet
 * already print (see handoff/freightRfqDocument.ts) so that everything a customer
 * receives reads as one system: the 52px mark, the company name in Georgia over a
 * navy rule, the red accent bar, and body copy in the same sans the proposal uses.
 * Nothing new is invented here — a payment letter is the last document that should
 * look like it came from somewhere else.
 */
export function letterheadHtml(input: LetterheadInput): string {
  const B = BRAND;
  const addressee = input.addressee
    .filter((l) => String(l ?? '').trim())
    .map((l, i) => `<div${i === 0 ? ' style="font-weight:600;"' : ''}>${esc(l)}</div>`)
    .join('');

  const senderLines = [
    input.sender.name,
    input.sender.title ?? '',
    input.sender.email ?? '',
    input.sender.phone ?? '',
  ]
    .filter((l) => String(l ?? '').trim())
    .map(
      (l, i) =>
        `<div style="${
          i === 0
            ? `font-family:Georgia,'Times New Roman',serif;font-size:11pt;font-weight:700;color:${B.navy};`
            : `color:${B.muted};font-size:9.5pt;`
        }">${esc(l)}</div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(input.title)}</title>
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.6; color: ${B.ink};
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { box-sizing: border-box; width: 8.5in; min-height: 11in; padding: 0.7in 0.8in 0.8in; }
  .head { display: flex; align-items: center; gap: 13pt; padding-bottom: 11pt; border-bottom: 1.5px solid ${B.navy}; }
  .head img { width: 52px; height: 52px; display: block; flex: none; }
  .head .name { font-family: Georgia,'Times New Roman',serif; font-size: 14.5pt; font-weight: 700; letter-spacing: -.01em; color: ${B.navy}; line-height: 1.15; }
  .head .sub { font-size: 8pt; letter-spacing: .16em; text-transform: uppercase; color: ${B.muted}; margin-top: 3pt; }
  .accent { height: 3px; background: ${B.red}; margin-top: 2px; }
  .date { margin-top: 24pt; color: ${B.muted}; font-size: 9.5pt; }
  .to { margin-top: 14pt; line-height: 1.45; }
  h1 { font-family: Georgia,'Times New Roman',serif; font-size: 13pt; font-weight: 700; color: ${B.navy}; letter-spacing: -.01em; margin: 22pt 0 12pt; }
  p { margin: 0 0 10pt; }
  b, strong { color: ${B.ink}; }
  table { border-collapse: collapse; }
  .sign { margin-top: 26pt; padding-top: 10pt; border-top: 1px solid ${B.navyRule}; }
  .foot { margin-top: 30pt; border-top: 1px solid ${B.navyRule}; padding-top: 7pt; font-size: 8pt; color: ${B.faint}; }
</style></head>
<body><div class="sheet">
  <div class="head">
    <img src="${LOGO_DATA_URI}" alt="Summit Sensory Gym">
    <div><div class="name">Summit Sensory Gym</div><div class="sub">Accounts Receivable</div></div>
  </div>
  <div class="accent"></div>
  <div class="date">${esc(input.dateLine)}</div>
  <div class="to">${addressee}</div>
  <h1>${esc(input.title)}</h1>
  ${input.bodyHtml}
  <div class="sign">${senderLines}</div>
  <div class="foot">Summit Sensory Gym &middot; This letter accompanies the invoice referenced above.</div>
</div></body></html>`;
}

/** Render a letter to PDF. Runs only on the renderer function — see api/render.ts. */
export async function letterPdf(input: LetterheadInput): Promise<Buffer> {
  return renderPdf(letterheadHtml(input), { edgeToEdge: true });
}

/** Clean template HTML on the way into the database. */
export function sanitizeTemplateHtml(html: string): string {
  return sanitizeSignature(html);
}

/**
 * A filename a customer can file. `Payment-Notice-INV-1042.pdf` rather than a
 * cuid — this lands in somebody's downloads folder next to nine other PDFs.
 */
export function letterFilename(templateName: string, docNumber: string | null): string {
  const base = `${templateName}${docNumber ? ` ${docNumber}` : ''}`
    .replace(/[^A-Za-z0-9 ._-]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `${base || 'Letter'}.pdf`;
}

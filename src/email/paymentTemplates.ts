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
  { token: 'customer_title', means: 'The recipient’s job title' },
  { token: 'organization_name', means: 'The customer’s organization' },
  { token: 'customer_address', means: 'Street address, as billed' },
  { token: 'customer_city_state_zip', means: 'City, state and postal code' },
  { token: 'invoice_number', means: 'QuickBooks invoice number' },
  { token: 'invoice_date', means: 'The date the invoice was issued' },
  { token: 'invoice_amount', means: 'The invoice total as originally issued' },
  { token: 'invoice_link', means: 'Invoice and payment link, from the monday deal row' },
  { token: 'balance_due', means: 'Outstanding now' },
  { token: 'amount_paid', means: 'Received against this invoice so far' },
  { token: 'payments_credits', means: 'Payments and credits applied, same figure as amount_paid' },
  { token: 'due_date', means: 'The invoice due date' },
  { token: 'days_past_due', means: 'Whole days past due, or 0' },
  { token: 'po_number', means: 'The customer’s purchase-order number' },
  { token: 'order_number', means: 'Summit order number' },
  { token: 'proposal_number', means: 'The accepted proposal' },
  { token: 'sender_name', means: 'You' },
  { token: 'sender_title', means: 'Your title' },
  { token: 'sender_email', means: 'Your email address' },
  { token: 'sender_phone', means: 'Your phone number' },
  { token: 'customer_service_email', means: 'The customer-service inbox' },
  { token: 'customer_service_phone', means: 'The customer-service line' },
  { token: 'today', means: 'Today’s date' },
  { token: 'tentative_ship_date', means: 'Typed in when you send', entered: true },
  { token: 'payment_deadline', means: 'Typed in when you send', entered: true },
  { token: 'final_payment_deadline', means: 'Typed in when you send', entered: true },
];

export const ENTERED_FIELDS = MERGE_FIELDS.filter((f) => f.entered).map((f) => f.token);

export type MergeValues = Record<string, string>;

/**
 * A template that ships with the app.
 *
 * Declared as one shape so the seeder can iterate emails and letters together. Kept
 * structural rather than split per kind: the only difference is pairedLetterKey,
 * which a letter simply never carries, and two near-identical interfaces would be two
 * places to add the next field to.
 */
export interface BuiltInTemplate {
  key: string;
  kind: TemplateKind;
  name: string;
  stage: number;
  whenToUse: string;
  subject: string;
  bodyHtml: string;
  /** EMAIL only — the letter this email is normally sent with. */
  pairedLetterKey?: string | null;
}

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
      return `<a href="${esc(value)}" style="color:${BRAND.navy};">${esc(value)}</a>`;
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
export const DEFAULT_EMAIL_TEMPLATE: BuiltInTemplate = {
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
 * The PAY-01 email: the message the advance-balance letter travels with.
 *
 * It repeats the figures rather than pointing at the attachment. An email that says
 * "see the attached letter" asks the reader to open a PDF before they know whether it
 * concerns them, and the person who has to forward it to accounts payable cannot do
 * so from what they can see. The letter is the formal record; the email is the thing
 * that gets read.
 */
export const PAY01_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-01-upcoming-shipment',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-01 — Upcoming Shipment: Payment Requested',
  stage: 1,
  whenToUse:
    'An order is nearing completion and the remaining balance is being requested before it ships.',
  /** Sent with the PAY-01 letter by default. */
  pairedLetterKey: 'tentative-ship-advance-balance',
  subject: 'Upcoming Shipment – Payment Requested for Invoice {{invoice_number}}',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>I wanted to let you know that your Summit Sensory Gym order is progressing toward completion and is currently tentatively scheduled to ship on or around {{tentative_ship_date}}.</p>',
    '<p>To help ensure that your order can be released without delay once it is ready, we are requesting payment of the remaining balance of <b>{{balance_due}}</b> at this time.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>As outlined in the accepted proposal for your order, unless otherwise stated, the remaining balance is due prior to shipment.</p>',
    '<p>I have attached a formal payment request for your records. If payment has already been submitted, please send us the applicable remittance information so we can confirm that it has been properly applied.</p>',
    '<p>If you have any questions regarding the invoice or need additional documentation, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
    '<p>Thank You,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * Every email that ships with the app, in the order the picker shows them.
 *
 * Seeded by key, so adding one here puts it in front of every sender on the next read
 * without touching an email somebody has already edited.
 */
export const DEFAULT_EMAIL_TEMPLATES: BuiltInTemplate[] = [
  DEFAULT_EMAIL_TEMPLATE,
  PAY01_EMAIL_TEMPLATE,
];

/**
 * `{{FIGURES}}` is the one non-field placeholder: it drops in the figures table
 * above. Kept out of MERGE_FIELDS because it is a block, not a value, and letting
 * it into the field list would put it in the reference table as though it were one.
 */
export function expandFigures(html: string, values: MergeValues): string {
  return String(html ?? '').replace(/\{\{\s*FIGURES\s*\}\}/g, () => figuresTable(values));
}

/* --------------------------------------------------- built-in letter templates */

/**
 * The letters that ship with the app.
 *
 * A letter's `subject` is its heading: letterheadHtml prints it as the h1, and the
 * date line, the addressee block and the sender's own block are printed by the
 * letterhead itself. So a letter body starts at its reference block and ends at the
 * sign-off — repeating any of them in the copy would print them twice on the page.
 */
export const DEFAULT_LETTER_TEMPLATES: BuiltInTemplate[] = [
  {
    key: 'tentative-ship-advance-balance',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-01 — Upcoming Shipment: Advance Balance Request',
    stage: 1,
    whenToUse:
      'An order is nearing completion and you want the remaining balance paid before it is released for shipment.',
    // Printed as the letter's heading, which is why it reads as a reference line: a
    // letter that says "Re:" at the top and then again in its first paragraph has
    // said it twice.
    subject: 'Re: Upcoming Shipment – Balance Payment Request for Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>Your Summit Sensory Gym order is currently tentatively scheduled to ship on or around {{tentative_ship_date}}.</p>',
      '<p>To help ensure your order can be released without delay once it is ready, we are requesting payment of the remaining balance of {{balance_due}} at this time.</p>',
      '<p>As outlined in the accepted proposal, unless otherwise stated, the remaining balance is due prior to shipment.</p>',
      // Inline-styled rather than classed or headed with an <h2>: an admin who edits
      // this letter saves it back through the signature allow-list, which keeps style
      // attributes and drops tags it does not know. Styling that survives that round
      // trip is styling that is still there on the tenth edit.
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 22px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0;">{{invoice_number}}</td></tr>',
      '<tr><td style="padding:0 22px 0 0;color:#4b5468;white-space:nowrap;"><b>Balance Due</b></td><td style="padding:0;"><b>{{balance_due}}</b></td></tr>',
      '<tr><td style="padding:0 22px 0 0;color:#4b5468;white-space:nowrap;">Tentative Ship Date</td><td style="padding:0;">{{tentative_ship_date}}</td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>If payment has already been submitted, please send the applicable remittance information so we can update your account.</p>',
      '<p>If you have questions regarding the invoice or payment, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to credit card payments. ACH and wire options are also available.</p>',
      '<p>Thank you for your prompt attention to this payment. We look forward to getting your order on its way.</p>',
      '<p>Sincerely,</p>',
    ].join('\n'),
  },
];

/* ----------------------------------------------------------------- the letter */

export interface LetterheadInput {
  /** The letter's heading, from the template's subject. */
  title: string;
  /** Rendered, sanitised body HTML. */
  bodyHtml: string;
  /** Who it is addressed to, printed as an address block: name, title, org, street, city line. */
  addressee: string[];
  /** The sender's own block, printed under the sign-off. */
  sender: {
    name: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    /**
     * The sender's handwritten signature as a data URI.
     *
     * A data URI and not a URL because renderPdf has no network — an <img src>
     * pointing at the app prints a broken image on a document a customer receives.
     * Absent when the CRM holds no signature for this person, and the space is then
     * simply left blank rather than filled with somebody else's name.
     */
    signatureDataUri?: string | null;
  };
  dateLine: string;
  /** Printed opposite the date, where the proposal's letter prints its number. */
  reference?: string | null;
}

/**
 * The letter, as a complete self-contained HTML document for the PDF renderer.
 *
 * This is the letterhead the executive letter inside a proposal already prints, to
 * the pixel: the 58px mark, the company name in Newsreader over the street line,
 * the date and reference set opposite it, the hairline rule, the 54px red accent,
 * and the 10px navy band closing the page. A customer who receives a proposal and
 * then a payment letter should not be able to tell they came from two features.
 *
 * The page is 816 x 1056 CSS px, which is 8.5 x 11in at 96dpi, so the geometry is
 * shared with the proposal's front matter rather than converted into points and
 * rounded differently. Margins match it as well: 70px sides.
 *
 * Body copy is single-spaced with a 10px gap between paragraphs — single spacing
 * inside a paragraph, a clear space between them, which is how a business letter
 * reads. PAY-01 uses about three quarters of the page, so a long organization name or
 * a two-line street address has room before it pushes onto a second page.
 *
 * A second page is nonetheless handled rather than hoped against: the navy band is
 * position:fixed, which Chromium repeats on every printed page, and the figures block
 * and the signature both carry page-break-inside:avoid so a sign-off can never be
 * separated from the name under it. Continuation pages carry no letterhead, which is
 * the convention for business correspondence.
 *
 * Self-contained is a hard requirement: renderPdf runs headless Chromium with no
 * network access, so the mark travels as the data URI in brandLogo.ts and the type
 * falls back to Georgia and the system sans rather than fetching webfonts.
 */
export function letterheadHtml(input: LetterheadInput): string {
  const B = BRAND;
  const SERIF = "'Newsreader',Georgia,'Times New Roman',serif";
  const SANS = "'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif";

  const addressee = input.addressee
    .filter((l) => String(l ?? '').trim())
    .map(
      (l, k) => `<div${k === 0 ? ' style="font-weight:600;"' : ''}>${esc(String(l).trim())}</div>`,
    )
    .join('');

  // Four line breaks' worth of space for a wet signature (4 x 18.6px), per the house rule, or the
  // stored signature dropped into that same space when there is one.
  const sig = String(input.sender.signatureDataUri ?? '').trim();
  const signature = sig
    ? `<img src="${esc(sig)}" alt="" style="width:90px;height:auto;display:block;margin:0 0 2px -4px;">`
    : '<div style="height:74px;"></div>';

  const senderLine = (html: string, bold = false) =>
    `<div style="${bold ? 'font-weight:700;' : ''}">${html}</div>`;

  const senderBlock = [
    senderLine(esc(input.sender.name), true),
    String(input.sender.title ?? '').trim()
      ? senderLine(esc(String(input.sender.title).trim()))
      : '',
    senderLine('Summit Sensory Gym', true),
    String(input.sender.phone ?? '').trim()
      ? senderLine(esc(String(input.sender.phone).trim()))
      : '',
    String(input.sender.email ?? '').trim()
      ? senderLine(esc(String(input.sender.email).trim()))
      : '',
  ]
    .filter(Boolean)
    .join('');

  const reference = String(input.reference ?? '').trim();

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(input.title)}</title>
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${SANS}; font-size: 11.5px; line-height: 1.62; color: ${B.ink};
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { box-sizing: border-box; width: 816px; min-height: 1056px; background: #fff;
          padding: 46px 70px 30px; }
  /* Fixed, so Chromium paints it at the foot of every printed page, not just the last. */
  .band { position: fixed; left: 0; right: 0; bottom: 0; height: 10px; background: ${B.navy}; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
          padding-bottom: 18px; border-bottom: 1px solid ${B.navyRule}; }
  .head img { width: 58px; height: 58px; display: block; flex: none; }
  .head .name { font-family: ${SERIF}; font-size: 19px; font-weight: 700; color: ${B.navy}; letter-spacing: -.01em; }
  .head .street { font-size: 10.5px; color: ${B.muted}; line-height: 1.5; margin-top: 2px; }
  .head .ref { text-align: right; font-size: 10.5px; color: ${B.muted}; line-height: 1.7; white-space: nowrap; }
  .accent { width: 54px; height: 3px; background: ${B.red}; margin-top: 26px; }
  h1 { font-family: ${SERIF}; font-size: 20px; font-weight: 700; color: ${B.navy};
       letter-spacing: -.02em; line-height: 1.28; margin: 14px 0 0; max-width: 660px; }
  /* The address block sits in the letter's own paragraph rhythm: a 10px space
     before and after it, and the body's leading, so it reads as the first block of
     the letter rather than as part of the letterhead. */
  .to { margin-top: 10px; }
  .body { margin-top: 10px; max-width: 676px; text-wrap: pretty; }
  .body p { margin: 0 0 10px; }
  /* "Sincerely," belongs to the signature, not to the body: no gap under it, so the
     mark sits directly beneath the sign-off the way it does on a signed page. */
  .body p:last-child { margin-bottom: 0; }
  .body table { font-size: 11.5px; }
  .body table td { vertical-align: top; }
  .body a { color: ${B.navy}; }
  .sign { margin-top: 2px; page-break-inside: avoid; }
  .sign .who { margin-top: 9px; font-size: 11.5px; line-height: 1.6; color: ${B.ink}; }
</style></head>
<body><div class="page">
  <div class="head">
    <div style="display:flex;gap:14px;align-items:center;">
      <img src="${LOGO_DATA_URI}" alt="Summit Sensory Gym">
      <div>
        <div class="name">Summit Sensory Gym</div>
        <div class="street">6150 S Geneva Ct, Englewood, CO 80111 &middot; SummitSensory.com</div>
      </div>
    </div>
    <div class="ref">${esc(input.dateLine)}${reference ? `<br>${esc(reference)}` : ''}</div>
  </div>
  <div class="accent"></div>
  <h1>${esc(input.title)}</h1>
  <div class="to">${addressee}</div>
  <div class="body">${input.bodyHtml}</div>
  <div class="sign">
    ${signature}
    <div class="who">${senderBlock}</div>
  </div>
</div><div class="band"></div></body></html>`;
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

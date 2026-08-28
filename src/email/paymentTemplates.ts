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
  const SERIF = "Georgia,'Times New Roman',serif";
  const SANS = "Calibri,'Segoe UI',Arial,sans-serif";
  // Tables and inline styles only, and no logo: Outlook desktop drops data-URI images
  // and shows a broken-image frame in their place, so the letterhead is carried
  // typographically — the serif company name, the navy rule and the red accent that the
  // printed letter opens with. Everything here survives Word's rendering engine.
  return (
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;">` +
    `<tr><td style="padding:0;">` +
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:660px;font-family:${SANS};font-size:11pt;color:${BRAND.ink};line-height:1.5;">` +
    `<tr><td style="padding:0 0 10px;border-bottom:1px solid ${BRAND.navyRule};">` +
    `<div style="font-family:${SERIF};font-size:15pt;font-weight:bold;color:${BRAND.navy};letter-spacing:-.01em;">Summit Sensory Gym</div>` +
    `<div style="font-size:8.5pt;color:${BRAND.muted};padding-top:2px;">6150 S Geneva Ct, Englewood, CO 80111 &middot; SummitSensory.com</div>` +
    `</td></tr>` +
    `<tr><td style="padding:0;"><table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="width:54px;height:3px;background:${BRAND.red};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>` +
    `<tr><td style="padding:16px 0 0;">${bodyHtml}</td></tr>` +
    `<tr><td style="padding:14px 0 0;border-top:1px solid ${BRAND.navyRule};font-size:8.5pt;color:${BRAND.muted};">Summit Sensory Gym &middot; 720-457-5500 &middot; orders@summitsensory.com</td></tr>` +
    `</table></td></tr></table>`
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
    `<div style="font-family:Georgia,'Times New Roman',serif;font-size:11.5pt;font-weight:bold;color:${BRAND.navy};padding:0 0 4pt;">Payment Information</div>` +
    '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 14pt;font-size:11pt;">' +
    rows
      .map(
        ([label, value]) =>
          '<tr>' +
          `<td style="padding:2pt 22pt 2pt 0;color:#4b5468;white-space:nowrap;">${esc(label)}</td>` +
          `<td style="padding:2pt 0;font-weight:${label === 'Balance due' ? 'bold' : 'normal'};">${esc(String(value))}</td>` +
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
/**
 * The PAY-02 email: the order is finished and payment is what stands between it and
 * a truck.
 *
 * Shorter than PAY-01 on purpose. PAY-01 explains a schedule; this one states a
 * condition, and the detail — invoice history, fee terms, documentation — is in the
 * attached letter, which is the record anyone in accounts payable will ask for.
 */
export const PAY02_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-02-ready-to-ship',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-02 — Order Ready to Ship: Payment Required for Release',
  stage: 2,
  whenToUse:
    'The order is complete and will not be released for shipment until the remaining balance is received.',
  /** Sent with the PAY-02 letter by default. */
  pairedLetterKey: 'ready-to-ship-payment-required',
  subject: 'Action Required: Payment Needed to Release Your Summit Order for Shipment',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>Your Summit Sensory Gym order is ready to be released for shipment.</p>',
    '<p>Our records currently show a remaining balance of <b>{{balance_due}}</b>. As outlined in the accepted proposal for your order, the remaining balance is due prior to shipment unless otherwise specifically stated.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>Once payment has been received and applied to your account, our team can proceed with release of the order and coordinate shipment.</p>',
    '<p>I have attached a formal payment request for your records.</p>',
    '<p>If payment has already been submitted, please send the payment date and remittance information so that we can verify receipt and avoid delaying your shipment.</p>',
    '<p>Questions regarding the invoice or payment can be directed to our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
    '<p>Thank you,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * PAY-03 — the purchase-order submission.
 *
 * The reader here is usually Accounts Payable rather than the person who signed, so
 * the PO number leads and the two figures they will key in are in the body. The
 * enclosure — a copy of the PO — is what stops the invoice bouncing back for
 * reconciliation.
 */
export const PAY03_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-03-purchase-order',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-03 — Purchase Order Payment Request',
  stage: 3,
  whenToUse:
    'The customer buys on a purchase order and the invoice needs to be submitted against it for payment.',
  pairedLetterKey: 'purchase-order-payment-request',
  subject: 'Payment Request – PO {{po_number}} / Invoice {{invoice_number}}',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>We are submitting Invoice {{invoice_number}}, associated with Purchase Order {{po_number}}, for payment.</p>',
    '<p>Balance Due: <b>{{balance_due}}</b><br>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>For your convenience, we have attached the formal payment request along with a copy of Purchase Order {{po_number}} to assist with reconciliation and processing.</p>',
    '<p>If your Accounts Payable team requires additional documentation or has questions regarding the invoice, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
    '<p>If payment has already been issued, please send the applicable remittance information so we can properly apply it to the account.</p>',
    '<p>Thank you,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * PAY-04 — the first follow-up after a due date has passed.
 *
 * Written on the assumption that nothing is wrong except a queue. Naming the cause
 * — approval or AP processing — gives the reader a reply they can send without
 * having to admit anything, which is what actually moves an invoice.
 */
export const PAY04_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-04-friendly-reminder',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-04 — Outstanding Balance: Friendly Reminder',
  stage: 4,
  whenToUse: 'A balance has passed its due date and no payment or reply has come back yet.',
  pairedLetterKey: 'outstanding-balance-friendly-reminder',
  subject: 'Friendly Payment Reminder – Invoice {{invoice_number}} – {{balance_due}} Due',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>I wanted to follow up regarding the outstanding balance of <b>{{balance_due}}</b> associated with Invoice {{invoice_number}}.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>We understand that invoices can occasionally become delayed during internal approval or Accounts Payable processing. If there is anything your team needs from us to process the invoice, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
    '<p>The formal payment reminder is attached for your records.</p>',
    '<p>If payment has already been submitted, please send the applicable remittance information so we can update the account.</p>',
    '<p>Thank you,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * PAY-05 — the second request.
 *
 * The change from PAY-04 is one sentence: no payment AND no date. That is the fact
 * that justifies asking again, and it is stated rather than implied.
 */
export const PAY05_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-05-second-request',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-05 — Outstanding Balance: Second Payment Request',
  stage: 5,
  whenToUse: 'A reminder has gone out and no payment or payment date has been confirmed.',
  pairedLetterKey: 'outstanding-balance-second-request',
  subject: 'Second Payment Request – Invoice {{invoice_number}} – {{balance_due}} Outstanding',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>I am following up again regarding the <b>{{balance_due}}</b> outstanding balance associated with Invoice {{invoice_number}}.</p>',
    '<p>As of today, we have not yet received payment or confirmation regarding when payment will be issued.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>Please have your Accounts Payable team review the invoice and arrange for payment.</p>',
    '<p>If there is a documentation issue, invoice discrepancy, purchase order issue, or another requirement preventing payment, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}} so we can address it promptly.</p>',
    '<p>The formal second payment request is attached for your records.</p>',
    '<p>If payment has already been submitted, please send the applicable remittance information so we can update your account.</p>',
    '<p>Thank you,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * PAY-06 — formal notice.
 *
 * The first message in the sequence that states remedies. It states them as the
 * accepted terms provide them and nothing further: a threat the contract does not
 * support is worse than no threat, and the letter is the document that gets quoted.
 */
export const PAY06_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-06-past-due-notice',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-06 — Formal Past-Due Notice',
  stage: 6,
  whenToUse: 'Previous requests have gone unanswered and the balance needs formal notice.',
  pairedLetterKey: 'formal-past-due-notice',
  subject: 'Formal Past-Due Notice – Payment Required for Invoice {{invoice_number}}',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>This email is a formal follow-up regarding Invoice {{invoice_number}}, which currently has an outstanding balance of <b>{{balance_due}}</b> and is {{days_past_due}} days past due.</p>',
    '<p>Payment is requested no later than {{payment_deadline}}.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>The accepted proposal for this order provides that past-due payments may be subject to applicable late charges, collection costs, and other remedies provided under the agreement. Summit Sensory Gym also reserves the right to suspend remaining performance while required payments remain past due.</p>',
    '<p>If there is an issue preventing payment or you dispute a portion of the invoice, please contact our Customer Service team immediately at {{customer_service_email}} or {{customer_service_phone}}. Any undisputed portion of the invoice remains due in accordance with the accepted payment terms.</p>',
    '<p>The formal past-due notice is attached for your records.</p>',
    '<p>If payment has already been issued, please send the applicable remittance information immediately so we can update the account.</p>',
    '<p>Thank you for your prompt attention to this matter.</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

/**
 * PAY-07 — final notice.
 *
 * The last message before escalation, and the one that has to be exact. It asks for
 * a date in writing if payment cannot be made, because a documented reason is what
 * a dispute turns on later.
 */
export const PAY07_EMAIL_TEMPLATE: BuiltInTemplate = {
  key: 'pay-07-final-notice',
  kind: 'EMAIL' as TemplateKind,
  name: 'PAY-07 — Final Payment Notice',
  stage: 7,
  whenToUse: 'The last notice before the balance is escalated beyond ordinary correspondence.',
  pairedLetterKey: 'final-payment-notice',
  subject:
    'FINAL NOTICE – Immediate Payment Required – Invoice {{invoice_number}} – {{balance_due}}',
  bodyHtml: [
    '<p>Dear {{customer_first_name}},</p>',
    '<p>This email serves as Summit Sensory Gym’s final payment notice regarding Invoice {{invoice_number}}.</p>',
    '<p>The outstanding balance of <b>{{balance_due}}</b> remains unpaid and is currently {{days_past_due}} days past due.</p>',
    '<p>Payment is required in full no later than {{final_payment_deadline}}.</p>',
    '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
    '<p>The accepted proposal for this order provides for applicable remedies when required payments remain past due, including potential late charges, collection costs, and suspension of Summit Sensory Gym’s remaining performance, as permitted under the agreement and applicable law.</p>',
    '<p>If payment cannot be completed by the deadline, please contact us immediately and provide the reason payment has not been released and the specific date payment will be issued.</p>',
    '<p>If you dispute any portion of the invoice, please identify the disputed amount and basis for the dispute. All undisputed amounts remain due in accordance with the accepted payment terms.</p>',
    '<p>Questions or requests for supporting documentation should be directed immediately to our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
    '<p>The formal final payment notice is attached for your records.</p>',
    '<p>If payment has already been issued, please send the payment date and remittance information immediately so we can update the account.</p>',
    '<p>Thank you,</p>',
    '<p>{{sender_name}}</p>',
  ].join('\n'),
};

export const DEFAULT_EMAIL_TEMPLATES: BuiltInTemplate[] = [
  DEFAULT_EMAIL_TEMPLATE,
  PAY01_EMAIL_TEMPLATE,
  PAY02_EMAIL_TEMPLATE,
  PAY03_EMAIL_TEMPLATE,
  PAY04_EMAIL_TEMPLATE,
  PAY05_EMAIL_TEMPLATE,
  PAY06_EMAIL_TEMPLATE,
  PAY07_EMAIL_TEMPLATE,
];

/**
 * `{{FIGURES}}` is the one non-field placeholder: it drops in the figures table
 * above. Kept out of MERGE_FIELDS because it is a block, not a value, and letting
 * it into the field list would put it in the reference table as though it were one.
 */
export function expandFigures(html: string, values: MergeValues): string {
  return String(html ?? '').replace(/\{\{\s*FIGURES\s*\}\}/g, () => figuresTable(values));
}

/**
 * Pull the enclosure notation out of a letter body.
 *
 * An enclosure line belongs below the signature block, and a template body cannot
 * put anything there — letterheadHtml prints the signature itself, so a body that
 * ends with “Enclosure: …” prints it above the sign-off, which is backwards.
 *
 * Rather than invent a syntax for it, the paragraph is recognised by what it says.
 * An admin writes “Enclosure: Purchase Order {{po_number}}” as ordinary copy, in the
 * natural place at the end of the letter, and it is lifted out and printed where the
 * convention puts it. A letter with no such paragraph is returned untouched.
 */
const ENCLOSURE_P_RE = /<p\b[^>]*>\s*(?:<[^>]+>\s*)*Enclosures?\s*:[\s\S]*?<\/p>/i;

export function splitEnclosure(html: string): {
  bodyHtml: string;
  enclosureHtml: string | null;
} {
  const source = String(html ?? '');
  const m = source.match(ENCLOSURE_P_RE);
  if (!m) return { bodyHtml: source, enclosureHtml: null };
  const inner = m[0]
    .replace(/^<p\b[^>]*>/i, '')
    .replace(/<\/p>\s*$/i, '')
    .trim();
  return { bodyHtml: source.replace(m[0], ''), enclosureHtml: inner || null };
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
  {
    key: 'ready-to-ship-payment-required',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-02 — Order Ready to Ship: Payment Required for Release',
    stage: 2,
    whenToUse:
      'The order has completed production and will be held until the remaining balance is received.',
    subject: 'Re: Order Ready for Shipment – {{order_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>We are pleased to let you know that your Summit Sensory Gym order has completed the applicable production requirements and is ready to be released for shipment.</p>',
      '<p>Our records currently show a remaining balance of {{balance_due}}.</p>',
      '<p>As outlined in the proposal accepted and signed for this order, unless otherwise specifically stated, the remaining balance is due prior to shipment. Accordingly, payment of the required balance must be received before Summit Sensory Gym can release the order for shipment.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Order / Proposal #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{order_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Original Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Balance Due</b></td><td style="padding:0;white-space:nowrap;"><b>{{balance_due}}</b></td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>We encourage you to arrange for payment promptly so that your shipment is not unnecessarily delayed. Once payment has been received and applied to your account, our team can proceed with release of the order and coordinate the applicable freight and delivery arrangements.</p>',
      '<p>If payment has already been submitted, please provide the payment date and remittance information so that we can verify receipt and release your order as quickly as possible.</p>',
      '<p>If you have any questions regarding the invoice, balance due, payment options, or supporting documentation, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
      '<p><b>Credit Card Payments:</b> Payments made by credit card are subject to a 3.5% processing fee in accordance with the accepted proposal and payment terms. ACH and wire payment options are also available.</p>',
      '<p>Thank you for your prompt attention to this payment. We are excited to get your Summit equipment on its way to you.</p>',
      '<p>Sincerely,</p>',
    ].join('\n'),
  },
  {
    key: 'purchase-order-payment-request',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-03 — Purchase Order Payment Request',
    stage: 3,
    whenToUse:
      'The customer buys on a purchase order and their Accounts Payable team needs the invoice submitted against it.',
    subject: 'Re: Purchase Order {{po_number}} – Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>Summit Sensory Gym is submitting Invoice {{invoice_number}}, associated with Purchase Order {{po_number}}, for payment.</p>',
      '<p>The proposal accepted in connection with this order became a binding agreement upon acceptance and confirmed the Customer’s authorization of the order, applicable payment schedule, and Summit Sensory Gym Standard Terms &amp; Conditions of Sale.</p>',
      '<p>According to our records, a balance of {{balance_due}} is currently due. For your convenience, we have included a copy of Purchase Order {{po_number}} with this submission to assist your Accounts Payable team with reconciliation and processing.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Purchase Order #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{po_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payment Due Date</td><td style="padding:0;white-space:nowrap;">{{due_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits Received</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Balance Due</b></td><td style="padding:0;white-space:nowrap;"><b>{{balance_due}}</b></td><td></td><td></td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>Please process the balance in accordance with the applicable purchase order, accepted proposal, invoice, and agreed payment terms.</p>',
      '<p>If your Accounts Payable team requires additional documentation or has questions regarding this invoice, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}. We are happy to provide any information needed to facilitate payment.</p>',
      '<p>If payment has already been issued, please provide the applicable remittance information so that we can properly reconcile the account.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to payments made by credit card. ACH and wire payment options are also available.</p>',
      '<p>Thank you for your attention to this request and for your partnership with Summit Sensory Gym.</p>',
      '<p>Sincerely,</p>',
      // Printed BELOW the signature block, where the convention puts it. splitEnclosure
      // lifts this paragraph out of the body wherever it sits, so it reads in the
      // natural place in the editor and prints in the right place on the page.
      '<p>Enclosure: Purchase Order {{po_number}}</p>',
    ].join('\n'),
  },
  {
    key: 'outstanding-balance-friendly-reminder',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-04 — Outstanding Balance: Friendly Reminder',
    stage: 4,
    whenToUse:
      'A balance has passed its due date and the likely cause is an internal approval or Accounts Payable delay.',
    subject: 'Re: Outstanding Balance – Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>We are following up regarding the outstanding balance associated with Summit Sensory Gym Invoice {{invoice_number}}.</p>',
      '<p>Our records currently show a balance of {{balance_due}} remaining due. As a reminder, the proposal accepted for this order established the applicable payment schedule and became a binding agreement upon acceptance.</p>',
      '<p>We understand that invoices can occasionally become delayed during internal approval or Accounts Payable processing, so we wanted to make sure your team has everything needed to complete payment.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payment Due Date</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{due_date}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits Received</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Balance Due</b></td><td style="padding:0;white-space:nowrap;"><b>{{balance_due}}</b></td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>If there is anything preventing the invoice from being processed, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}. We are happy to provide any information or supporting documentation needed to facilitate payment.</p>',
      '<p>If payment has already been submitted, please provide the applicable remittance information so that we can update our records.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to payments made by credit card. ACH and wire payment options are also available.</p>',
      '<p>Thank you for your attention to this balance and for your continued partnership with Summit Sensory Gym.</p>',
      '<p>Sincerely,</p>',
    ].join('\n'),
  },
  {
    key: 'outstanding-balance-second-request',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-05 — Outstanding Balance: Second Payment Request',
    stage: 5,
    whenToUse:
      'A reminder has gone out, the balance is still unpaid, and no payment date has been confirmed.',
    subject: 'Re: Second Request for Payment – Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>We are following up again regarding the outstanding balance associated with Summit Sensory Gym Invoice {{invoice_number}}.</p>',
      '<p>As of {{today}}, our records indicate that {{balance_due}} remains unpaid, and we have not yet received confirmation regarding when payment will be issued.</p>',
      '<p>The proposal accepted and signed for this order became a binding agreement and confirmed the Customer’s authorization of the order, applicable payment schedule, and Summit Sensory Gym Standard Terms &amp; Conditions of Sale.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payment Due Date</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{due_date}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Days Past Due</td><td style="padding:0;white-space:nowrap;">{{days_past_due}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits Received</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Balance Due</b></td><td style="padding:0;white-space:nowrap;"><b>{{balance_due}}</b></td><td></td><td></td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>Please arrange for payment of the outstanding balance promptly.</p>',
      '<p>If a documentation requirement, invoice discrepancy, purchase order issue, receiving requirement, or internal approval matter is preventing payment, please contact our Customer Service team at {{customer_service_email}} or {{customer_service_phone}} so that we can work with your team to resolve it.</p>',
      '<p>If payment has already been issued, please provide the payment date and applicable remittance information so that we can reconcile our records.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to payments made by credit card. ACH and wire payment options are also available.</p>',
      '<p>We appreciate your prompt attention to this matter.</p>',
      '<p>Sincerely,</p>',
    ].join('\n'),
  },
  {
    key: 'formal-past-due-notice',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-06 — Formal Past-Due Notice',
    stage: 6,
    whenToUse:
      'Previous requests have not been answered and the balance needs to be put on formal notice with a deadline.',
    subject: 'Re: Formal Notice of Past-Due Balance – Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>This letter serves as a formal notice of past-due payment regarding Summit Sensory Gym Invoice {{invoice_number}}.</p>',
      '<p>Despite our previous payment requests, the outstanding balance of {{balance_due}} remains unpaid and is currently {{days_past_due}} days past due.</p>',
      '<p>The proposal accepted and signed for this order became a binding agreement and confirmed the Customer’s authorization of the order, applicable payment schedule, and Summit Sensory Gym Standard Terms &amp; Conditions of Sale.</p>',
      '<p>Under the accepted payment terms, payments not received when due may be subject to late charges of 1.5% per month (18% annually), or the maximum amount permitted by applicable law, whichever is less, together with applicable collection costs and reasonable attorneys’ fees as permitted by law. Summit Sensory Gym also reserves the right to suspend production, shipment, installation, or other performance while required payments remain past due.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Original Due Date</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{due_date}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Days Past Due</td><td style="padding:0;white-space:nowrap;">{{days_past_due}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits Received</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Outstanding Balance</b></td><td style="padding:0 46px 0 0;white-space:nowrap;"><b>{{balance_due}}</b></td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payment Requested By</td><td style="padding:0;white-space:nowrap;">{{payment_deadline}}</td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>We request payment of the outstanding balance no later than {{payment_deadline}}.</p>',
      '<p>If there is an issue preventing payment, please contact our Customer Service team immediately at {{customer_service_email}} or {{customer_service_phone}} and provide the reason for the delay and anticipated payment date.</p>',
      '<p>If you dispute any portion of the invoice, please identify the specific disputed amount and basis for the dispute. As provided in the accepted payment terms, a dispute regarding any portion of an invoice does not relieve the Customer of the obligation to timely pay all undisputed amounts.</p>',
      '<p>If payment has already been issued, please provide the payment date and remittance information immediately so that we can update your account.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to payments made by credit card. ACH and wire payment options are also available.</p>',
      '<p>We value our relationship with {{organization_name}} and would prefer to resolve this outstanding balance promptly and administratively.</p>',
      '<p>Thank you for your immediate attention to this matter.</p>',
      '<p>Sincerely,</p>',
    ].join('\n'),
  },
  {
    key: 'final-payment-notice',
    kind: 'LETTER' as TemplateKind,
    name: 'PAY-07 — Final Payment Notice',
    stage: 7,
    whenToUse:
      'The last notice before the balance is escalated beyond ordinary collection correspondence.',
    subject: 'Re: Final Notice of Outstanding Balance – Invoice {{invoice_number}}',
    bodyHtml: [
      '<p>Dear {{customer_first_name}},</p>',
      '<p>This correspondence serves as Summit Sensory Gym’s final payment notice regarding Invoice {{invoice_number}}.</p>',
      '<p>Despite our previous payment requests, the outstanding balance of {{balance_due}} remains unpaid and is currently {{days_past_due}} days past due.</p>',
      '<p>The proposal accepted and signed for this order became a binding agreement and confirmed the Customer’s authorization of the order, applicable payment schedule, and Summit Sensory Gym Standard Terms &amp; Conditions of Sale.</p>',
      '<p>Under the accepted terms, payments not received when due may be subject to late charges of 1.5% per month (18% annually), or the maximum amount permitted by applicable law, whichever is less, together with applicable collection costs and reasonable attorneys’ fees as permitted by law. Summit Sensory Gym also reserves the right to suspend production, shipment, installation, or other performance while required payments remain past due.</p>',
      '<p style="font-family:Georgia,serif;font-size:14px;font-weight:700;color:#203060;margin:12px 0 3px;">Payment Information</p>',
      '<table style="border-collapse:collapse;margin:0 0 8px;page-break-inside:avoid;"><tbody>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice #</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_number}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Date</td><td style="padding:0;white-space:nowrap;">{{invoice_date}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Original Due Date</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{due_date}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Days Past Due</td><td style="padding:0;white-space:nowrap;">{{days_past_due}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Invoice Amount</td><td style="padding:0 46px 0 0;white-space:nowrap;">{{invoice_amount}}</td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Payments / Credits Received</td><td style="padding:0;white-space:nowrap;">{{payments_credits}}</td></tr>',
      '<tr><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;"><b>Outstanding Balance</b></td><td style="padding:0 46px 0 0;white-space:nowrap;"><b>{{balance_due}}</b></td><td style="padding:0 14px 0 0;color:#4b5468;white-space:nowrap;">Final Payment Deadline</td><td style="padding:0;white-space:nowrap;">{{final_payment_deadline}}</td></tr>',
      '</tbody></table>',
      '<p>Invoice &amp; Payment Link: {{invoice_link}}</p>',
      '<p>Payment of the outstanding balance is required in full no later than {{final_payment_deadline}}.</p>',
      '<p>If payment cannot be completed by this date, please provide written communication identifying the reason payment has not been released, any documentation or billing issue preventing payment, any amount being disputed, and the specific date payment will be issued.</p>',
      '<p>If you dispute any portion of the invoice, please identify the specific amount and basis for the dispute. As provided in the accepted terms, a dispute regarding a portion of an invoice does not relieve the Customer of the obligation to timely pay all undisputed amounts.</p>',
      '<p>Questions or requests for supporting documentation should be directed immediately to our Customer Service team at {{customer_service_email}} or {{customer_service_phone}}.</p>',
      '<p>Absent payment or communication regarding a legitimate billing dispute, continued nonpayment may require Summit Sensory Gym to pursue additional steps available to recover the outstanding balance consistent with the accepted agreement and applicable law.</p>',
      '<p>We would prefer to resolve this matter directly with your organization and avoid the need for further collection activity.</p>',
      '<p>If payment has already been issued, please provide the payment date and remittance information immediately so that we can update our records.</p>',
      '<p><b>Credit Card Payments:</b> A 3.5% processing fee applies to payments made by credit card. ACH and wire payment options are also available.</p>',
      '<p>Thank you for your immediate attention to this matter.</p>',
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
  /**
   * The enclosure notation, printed below the signature block — “Enclosure: Purchase
   * Order 44821”. Rendered HTML, already merged and sanitised; use splitEnclosure to
   * lift it out of a template body. Absent on a letter that encloses nothing, and the
   * space is then not reserved.
   */
  enclosureHtml?: string | null;
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

  // Only reserved when there is one — a blank enclosure line on a letter that
  // encloses nothing invites the question of what is missing.
  const enclosureHtml = String(input.enclosureHtml ?? '').trim();
  const enclosure = enclosureHtml ? `\n  <div class="encl">${enclosureHtml}</div>` : '';

  // Auto-fit. A payment letter is a one-page document by convention, and PAY-02 with a
  // six-row figures block runs about 95px past the fold at PAY-01's leading. Rather than
  // cut a sentence somebody wrote for legal reasons, a long letter is set one notch
  // tighter: 11px on 1.5 with 7px between paragraphs, which is still comfortably above
  // the readable floor for print. Measured on the body's plain text, so the threshold
  // does not move when an admin edits the markup around the same words.
  const plainLen = String(input.bodyHtml ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
  const dense = plainLen >= 1400;
  const M = dense
    ? { fs: '11px', lh: '1.5', gap: '7px', h1Top: '12px', accentTop: '20px' }
    : { fs: '11.5px', lh: '1.62', gap: '10px', h1Top: '14px', accentTop: '26px' };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(input.title)}</title>
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${SANS}; font-size: ${M.fs}; line-height: ${M.lh}; color: ${B.ink};
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
  .accent { width: 54px; height: 3px; background: ${B.red}; margin-top: ${M.accentTop}; }
  h1 { font-family: ${SERIF}; font-size: 20px; font-weight: 700; color: ${B.navy};
       letter-spacing: -.02em; line-height: 1.28; margin: ${M.h1Top} 0 0; max-width: 660px; }
  /* The address block sits in the letter's own paragraph rhythm: a 10px space
     before and after it, and the body's leading, so it reads as the first block of
     the letter rather than as part of the letterhead. */
  .to { margin-top: 10px; }
  .body { margin-top: 10px; max-width: 676px; text-wrap: pretty; }
  .body p { margin: 0 0 ${M.gap}; }
  /* "Sincerely," belongs to the signature, not to the body: no gap under it, so the
     mark sits directly beneath the sign-off the way it does on a signed page. */
  .body p:last-child { margin-bottom: 0; }
  .body table { font-size: ${M.fs}; }
  .body table td { vertical-align: top; }
  .body a { color: ${B.navy}; }
  .sign { margin-top: 2px; page-break-inside: avoid; }
  .sign .who { margin-top: 9px; font-size: ${M.fs}; line-height: 1.6; color: ${B.ink}; }
  /* The enclosure notation: two lines' space under the sender's block, per the
     convention, and never separated from it across a page break. */
  .encl { margin-top: 18px; font-size: ${M.fs}; line-height: 1.6; color: ${B.muted};
          page-break-inside: avoid; }
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
  </div>${enclosure}
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
 * The letter code at the front of a template name — “PAY-01” out of
 * “PAY-01 — Upcoming Shipment: Advance Balance Request”.
 *
 * Null when a template has no code, which is true of anything an admin writes from
 * scratch. The filename then falls back to the template's own name rather than
 * inventing a number that means nothing.
 */
export function letterCode(templateName: string): string | null {
  const m = /^\s*([A-Za-z]{2,6}-\d{1,3})\b/.exec(String(templateName ?? ''));
  // Bound before use: noUncheckedIndexedAccess types a capture group as possibly
  // undefined even when the regex guarantees it.
  const code = m?.[1];
  return code ? code.toUpperCase() : null;
}

/**
 * A filename a customer can file: `Heart of Occupation - PAY-01.pdf`.
 *
 * Customer first because these land in a downloads folder next to nine other PDFs
 * and get filed by who they are about, then the letter code so a second request to
 * the same customer does not silently overwrite the first.
 *
 * Spaces are kept — this is a document a person hands to their accounts team, not a
 * URL. Only the characters that break a filesystem or the Content-Disposition header
 * are stripped, and each part is capped because a long organisation name plus a mail
 * client's own prefix can exceed what Windows will save.
 */
export function letterFilename(templateName: string, customerName: string | null): string {
  const clean = (s: string, max: number): string =>
    String(s ?? '')
      .replace(/[^A-Za-z0-9 &(),._-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .replace(/[ .]+$/, '');
  const who = clean(customerName ?? '', 80);
  const what = clean(letterCode(templateName) ?? String(templateName ?? ''), 60);
  const base = [who, what].filter(Boolean).join(' - ');
  return `${base || 'Letter'}.pdf`;
}

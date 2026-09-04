/**
 * The "please sign this" email a proposal actually goes out with.
 *
 * Unlike FollowUpTemplate (plain text with markdown-ish bold, because a rep edits
 * it in a textarea and one broken tag would be a silently mangled nurture email),
 * these are stored as raw HTML. A signature request needs real formatting — a
 * signing-link button, brand color, a proposal summary — and it is always shown in
 * a live preview before it sends, so a malformed tag is caught in the preview, not
 * after the customer has it.
 *
 * There is no code-seeded default set, unlike DEFAULT_FOLLOW_UP_TEMPLATES. Product
 * lines are database rows with generated ids, unknowable at the time this file is
 * written, so `productLineIds` cannot be seeded from code — same reason
 * EsignDocumentTemplate ships with no seed data. Every EsignEmailTemplate is
 * created through the admin UI, same as the document templates it sits beside.
 */

import { esc, firstNameOf } from './textHelpers.js';

export { firstNameOf };

export interface EsignEmailContext {
  /** Recipient's first name. Falls back to "there" rather than printing a blank. */
  firstName: string;
  /** The sending rep's first name, for the sign-off. */
  senderFirstName: string;
  /** The sending rep's full name, for a formal reference in the body. */
  senderName?: string;
  customerName?: string;
  proposalNumber?: string;
  proposalTitle?: string;
  /** This recipient's own DocuSeal signing/viewing URL. */
  signingLink: string;
}

export interface EsignEmailTemplateData {
  key: string;
  name: string;
  subject: string;
  bodyHtml: string;
}

export interface RenderedEsignEmail {
  subject: string;
  html: string;
}

export const ESIGN_EMAIL_PLACEHOLDERS = [
  { token: '[First Name]', means: 'The recipient’s first name' },
  { token: '[Customer]', means: 'The customer’s organization name' },
  { token: '[Proposal Number]', means: 'e.g. P-2026-000063' },
  { token: '[Proposal]', means: 'The proposal title' },
  { token: '[Sender]', means: 'Your own first name' },
  { token: '[Sender Full Name]', means: 'Your own full name' },
  {
    token: '[Signing Link]',
    means:
      'The link the recipient opens to view or sign — put this in an href, e.g. <a href="[Signing Link]">Review &amp; sign</a>',
  },
];

/**
 * Substitute the placeholders a template may carry. Values go in unescaped — the
 * template author is writing raw HTML on purpose, and escaping `[Customer]` would
 * turn "Smith & Sons" into "Smith &amp;amp; Sons" once the surrounding markup is
 * already HTML. The one exception is `[Signing Link]`, which is a URL and always
 * belongs inside an `href="..."` written by the template, not as visible text.
 */
function fill(text: string, ctx: EsignEmailContext): string {
  return (
    String(text ?? '')
      .replace(/\[First Name\]/g, esc(ctx.firstName))
      .replace(/\[Customer\]/g, esc(ctx.customerName ?? ''))
      .replace(/\[Proposal Number\]/g, esc(ctx.proposalNumber ?? ''))
      .replace(/\[Proposal\]/g, esc(ctx.proposalTitle ?? ''))
      .replace(/\[Sender Full Name\]/g, esc(ctx.senderName ?? ctx.senderFirstName))
      .replace(/\[Sender\]/g, esc(ctx.senderFirstName))
      // A function replacer, not a string one — a future caller may pass a real,
      // externally-sourced signing URL here, and a string replacement would
      // misread a literal `$&`/`$1`/etc. in it as a regex replacement pattern.
      .replace(/\[Signing Link\]/g, () => ctx.signingLink)
  );
}

export function renderEsignEmail(
  template: EsignEmailTemplateData,
  ctx: EsignEmailContext,
): RenderedEsignEmail {
  return {
    subject: fill(template.subject, ctx),
    html: fill(template.bodyHtml, ctx),
  };
}

/** A sample context for the admin editor's live preview — no real proposal yet. */
export const SAMPLE_ESIGN_EMAIL_CONTEXT: EsignEmailContext = {
  firstName: 'Emily',
  senderFirstName: 'Bryan',
  senderName: 'Bryan Shepherd',
  customerName: 'Uniquely Yours Specialized Care',
  proposalNumber: 'P-2026-000063',
  proposalTitle: 'Comprehensive Sensory Therapy Gym',
  signingLink: 'https://docuseal.com/s/sample',
};

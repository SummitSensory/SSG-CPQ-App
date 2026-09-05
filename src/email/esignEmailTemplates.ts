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
 *
 * PLACEHOLDER FORMAT — one rule, no exceptions: `{{PascalCase}}`, double curly
 * braces, no space between words. That was a deliberate choice over the
 * bracket-with-spaces form this file shipped with first (`[First Name]`):
 * a missing or extra space inside a bracket token silently fails to match and
 * prints nothing, which is exactly the bug this format was chosen to close off.
 * `{{PascalCase}}` also reads unambiguously as a placeholder rather than as
 * ordinary bracketed prose a rep might otherwise type (“see the attached
 * drawing [Rev 2]”).
 *
 * The old `[Bracket Words]` tokens are still substituted below — silently,
 * with no comment in the admin UI — purely so an already-saved
 * EsignEmailTemplate keeps working. Nothing new should ever be written using
 * them; `ESIGN_EMAIL_PLACEHOLDERS`, the list the admin editor and the send
 * screen actually show, carries only the current `{{PascalCase}}` set.
 */

import { esc, firstNameOf, lastNameOf } from './textHelpers.js';

export { firstNameOf, lastNameOf };

export interface EsignEmailContext {
  /** Recipient's first name. Falls back to "there" rather than printing a blank. */
  firstName: string;
  /** Recipient's last name. Blank, not a fallback word, when there is none. */
  lastName?: string;
  /** The sending rep's first name. */
  senderFirstName: string;
  /** The sending rep's full name. */
  senderName?: string;
  customerName?: string;
  proposalNumber?: string;
  proposalTitle?: string;
  /** e.g. "V2" — one-indexed at the first released version. */
  proposalVersionLabel?: string;
  /** e.g. "September 4, 2026" — already formatted; see longDate() at the call site. */
  proposalDateLabel?: string;
  /** e.g. "October 4, 2026" — already formatted. */
  proposalExpirationLabel?: string;
  /**
   * The proposed model/product, e.g. "SQ-1" — read off the itemized frame
   * heading the same way proposalFileName() does (public/app.js), so this is
   * a display convenience, not a catalog lookup; it does not resolve to a
   * Product row.
   */
  productName?: string;
  /**
   * Which of the three frame product lines this proposal is — "Summit
   * Adventure", "Summit Flex", "Summit Soar", or "" when the proposal is not
   * one of them (a Basic/catalog-only order, or COVER explicitly chosen).
   * Not a catalog join: the same product-line detector the introduction
   * pages already use to pick which story to print (public/proposal-front-
   * matter.js, templateFor()) decides this too, computed once client-side so
   * the email and the introduction can never name two different lines for
   * the same proposal.
   */
  productLine?: string;
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

/**
 * The current, advertised set — shown in the admin editor's reference list and
 * the send screen's insert-variable picker. `{{PascalCase}}` only; see the file
 * header for why. Grouped for the picker's optgroups, in the order a rep is
 * most likely to want them.
 */
export const ESIGN_EMAIL_PLACEHOLDERS = [
  { token: '{{FirstName}}', group: 'Recipient', means: 'The recipient’s first name' },
  { token: '{{LastName}}', group: 'Recipient', means: 'The recipient’s last name' },
  { token: '{{OrganizationName}}', group: 'Recipient', means: 'The customer’s organization name' },
  { token: '{{ProjectName}}', group: 'Proposal', means: 'The proposal’s title' },
  {
    token: '{{ProductName}}',
    group: 'Proposal',
    means: 'The proposed model/product, read off the itemized heading — e.g. SQ-1',
  },
  {
    token: '{{ProductLine}}',
    group: 'Proposal',
    means:
      'Summit Adventure, Summit Flex or Summit Soar — blank if the proposal is none of the three',
  },
  { token: '{{ProposalNumber}}', group: 'Proposal', means: 'e.g. P-2026-000063' },
  { token: '{{ProposalVersion}}', group: 'Proposal', means: 'e.g. V2' },
  { token: '{{ProposalDate}}', group: 'Proposal', means: 'e.g. September 4, 2026' },
  { token: '{{ProposalExpirationDate}}', group: 'Proposal', means: 'e.g. October 4, 2026' },
  { token: '{{SenderFirstName}}', group: 'You', means: 'Your own first name' },
  { token: '{{SenderFullName}}', group: 'You', means: 'Your own full name' },
  {
    token: '{{SigningLink}}',
    group: 'Signing',
    means:
      'The link the recipient opens to view or sign — put this in an href, e.g. <a href="{{SigningLink}}">Review &amp; sign</a>',
  },
];

/**
 * Substitute the placeholders a template may carry. Values go in unescaped — the
 * template author is writing raw HTML on purpose, and escaping `{{OrganizationName}}`
 * would turn "Smith & Sons" into "Smith &amp;amp; Sons" once the surrounding markup
 * is already HTML. The one exception is the signing link, which is a URL and always
 * belongs inside an `href="..."` written by the template, not as visible text.
 */
function fill(text: string, ctx: EsignEmailContext): string {
  return (
    String(text ?? '')
      .replace(/\{\{FirstName\}\}/g, esc(ctx.firstName))
      .replace(/\{\{LastName\}\}/g, esc(ctx.lastName ?? ''))
      .replace(/\{\{OrganizationName\}\}/g, esc(ctx.customerName ?? ''))
      .replace(/\{\{ProjectName\}\}/g, esc(ctx.proposalTitle ?? ''))
      .replace(/\{\{ProductName\}\}/g, esc(ctx.productName ?? ''))
      .replace(/\{\{ProductLine\}\}/g, esc(ctx.productLine ?? ''))
      .replace(/\{\{ProposalNumber\}\}/g, esc(ctx.proposalNumber ?? ''))
      .replace(/\{\{ProposalVersion\}\}/g, esc(ctx.proposalVersionLabel ?? ''))
      .replace(/\{\{ProposalDate\}\}/g, esc(ctx.proposalDateLabel ?? ''))
      .replace(/\{\{ProposalExpirationDate\}\}/g, esc(ctx.proposalExpirationLabel ?? ''))
      .replace(/\{\{SenderFullName\}\}/g, esc(ctx.senderName ?? ctx.senderFirstName))
      .replace(/\{\{SenderFirstName\}\}/g, esc(ctx.senderFirstName))
      // A function replacer, not a string one, for both signing-link spellings:
      // a future caller may pass a real, externally-sourced signing URL here,
      // and a string replacement would misread a literal `$&`/`$1`/etc. in it
      // as a regex replacement pattern.
      .replace(/\{\{SigningLink\}\}/g, () => ctx.signingLink)
      // Legacy `[Bracket Words]` forms — substituted, never advertised. See
      // the file header. Left in place only so an EsignEmailTemplate saved
      // before this format existed keeps resolving correctly.
      .replace(/\[First Name\]/g, esc(ctx.firstName))
      .replace(/\[Customer\]/g, esc(ctx.customerName ?? ''))
      .replace(/\[Proposal Number\]/g, esc(ctx.proposalNumber ?? ''))
      .replace(/\[Proposal\]/g, esc(ctx.proposalTitle ?? ''))
      .replace(/\[Sender Full Name\]/g, esc(ctx.senderName ?? ctx.senderFirstName))
      .replace(/\[Sender\]/g, esc(ctx.senderFirstName))
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
  firstName: 'Mary',
  lastName: 'Loughney',
  senderFirstName: 'Bryan',
  senderName: 'Bryan Shepherd',
  customerName: 'Katonah-Lewisboro School District',
  proposalNumber: 'P-2026-000063',
  proposalTitle: 'KLSD Sensory Therapy Room',
  proposalVersionLabel: 'V2',
  proposalDateLabel: 'September 4, 2026',
  proposalExpirationLabel: 'October 4, 2026',
  productName: 'Summit Soar S1',
  productLine: 'Summit Soar',
  signingLink: 'https://docuseal.com/s/sample',
};

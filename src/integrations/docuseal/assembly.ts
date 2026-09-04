/**
 * Assembly: the signing package is composed here, in the CRM, before DocuSeal ever
 * sees it.
 *
 * One PDF, produced by the same headless Chromium that renders the proposal for
 * monday and for the customer email, so the document a customer signs is byte-for-
 * byte the document they were quoted. DocuSeal is a signature service in this
 * design, not a document builder.
 *
 * Composition order:
 *
 *   proposal body (fields placed in-line — see injectSignatureFields)
 *     →  attachment documents (in template sortOrder)
 *     →  fallback signature page, ONLY for whoever injectSignatureFields
 *        could not place — a signer beyond Customer/Summit, or a template
 *        with neither the Acceptance page nor the Acknowledgment
 *
 * A field is DocuSeal TEXT TAGS — ordinary text in the PDF that DocuSeal
 * recognises and turns into a fillable field:
 *
 *   {{Customer Signature;role=Customer;type=signature}}
 *
 * Field placement therefore lives in this layout rather than in stored
 * coordinates, which is what keeps a template edit from silently moving a
 * signature box off the page. The Customer and Summit roles get their fields
 * placed directly at the blank signature lines the proposal already prints —
 * the Acceptance page and the Product Use, Safety & Responsibility
 * Acknowledgment — rather than only on a page generated for the send; a
 * customer can only actually sign where a real field exists, and a printed
 * blank line with no field behind it is worse than no line at all.
 */

export interface AssemblyAttachment {
  key: string;
  name: string;
  bodyHtml: string;
}

export interface SignerSpec {
  role: string;
  name?: string;
  email: string;
  order?: number;
  /** Ask for a printed title line as well as the signature. */
  titleField?: boolean;
  /**
   * A CC recipient who can see the document but is not asked to accept it —
   * gets no signature block and no fields at all, which is what makes DocuSeal
   * treat them as view-only rather than a signer. See the EsignSigner.viewOnly
   * model comment for why this matters to completion, not just layout.
   */
  viewOnly?: boolean;
}

export interface AssemblyInput {
  proposalHtml: string;
  attachments?: AssemblyAttachment[];
  signers: SignerSpec[];
  /** Shown at the top of the signature page. */
  proposalNumber: string;
  proposalTitle?: string;
  customerName?: string;
  /** Total in minor units, printed on the signature page so the amount is signed. */
  totalMinor?: number;
  /** Extra sentence above the signature blocks — terms of acceptance, dates. */
  acceptanceCopy?: string;
}

const PAGE_BREAK = 'page-break-before: always; break-before: page;';

/**
 * Pull a fragment out of whatever the browser posted.
 *
 * The proposal HTML arrives as a complete document — `<html>`, a `<head>` with the
 * inline stylesheet, `<body>`. Nesting that inside another document produces markup
 * Chromium will render, but unpredictably: the inner `<style>` is hoisted by some
 * versions and dropped by others, and a proposal that lost its stylesheet went out
 * to a customer as unstyled text. Extract the style blocks and the body content
 * explicitly instead of trusting the parser to be forgiving.
 */
export function inlineDocument(html: string): { styles: string; body: string } {
  const styles = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1] ?? '')
    .join('\n');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? (bodyMatch[1] ?? '') : html;
  // A fragment (no <body>) may still open with a <style> block; it is in `styles`
  // now and must not render twice.
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  return { styles, body };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(minor: number): string {
  return `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A DocuSeal text tag. The role must match the submitter role sent to
 * `createSubmission`, or DocuSeal creates a second, empty submitter for it.
 */
function tag(name: string, role: string, type: string, opts: { required?: boolean } = {}): string {
  const parts = [name, `role=${role}`, `type=${type}`];
  if (opts.required === false) parts.push('required=false');
  return `{{${parts.join(';')}}}`;
}

/**
 * The two roles the send modal offers by default (see `esignRowHtml` in
 * app.js). A rep can rename either — these are only the names used to WORK
 * OUT which of the (possibly reordered, possibly renamed) signers plays which
 * part in the document, not a constraint on what actually gets sent.
 */
export const CUSTOMER_ROLE = 'Customer';
export const SUMMIT_ROLE = 'Summit';

/**
 * Where a signer's fields land directly in the proposal's own pages — the
 * ids are added once, in public/proposal-document.js (Acceptance) and
 * public/contract-pages.js (the Product Use, Safety & Responsibility
 * Acknowledgment) — rather than only on a page generated for the send.
 *
 * Distinct field names per slot rather than one shared field repeated across
 * both pages: accepting the commercial terms and acknowledging the safety
 * terms are two different acts of consent, and DocuSeal should capture them
 * as two fields, not silently treat a signature on one page as covering both.
 */
interface SignatureSlot {
  sigId: string;
  dateId: string;
  label: string;
}
const CUSTOMER_SLOTS: SignatureSlot[] = [
  { sigId: 'ssgSigAcceptanceSignature', dateId: 'ssgSigAcceptanceDate', label: 'Customer' },
  {
    sigId: 'ssgSigAckCustomerSignature',
    dateId: 'ssgSigAckCustomerDate',
    label: 'Customer Acknowledgment',
  },
];
const SUMMIT_SLOTS: SignatureSlot[] = [
  {
    sigId: 'ssgSigAckSummitSignature',
    dateId: 'ssgSigAckSummitDate',
    label: 'Summit Acknowledgment',
  },
];

/**
 * Fills every occurrence of an empty `<div id="...">` — global, not just the
 * first, because an administrator can add a second ARTICLES-kind legal
 * document (see src/routes/legalDocuments.ts) that would render the same
 * `sigBlock` markup, ids included, a second time.
 */
function fillSlot(
  html: string,
  id: string,
  replacement: string,
): { html: string; placed: boolean } {
  const re = new RegExp(`(<div id="${id}"[^>]*>)(</div>)`, 'g');
  let placed = false;
  const out = html.replace(re, (_match, open: string, close: string) => {
    placed = true;
    return `${open}${replacement}${close}`;
  });
  return { html: out, placed };
}

/**
 * Places each signer's actual signature/date fields at the specific spots in
 * the proposal where the document already prints a blank signature line,
 * instead of on a separately generated page.
 *
 * Matches by role, resolved the same way `firstNameOfContact` already does
 * for the email greeting: the signer explicitly marked Customer/Summit if
 * there is one, otherwise a positional fallback — a rep can rename or
 * reorder the two rows the send modal starts with. Returns which roles
 * actually found a slot in this document, so the caller knows who still
 * needs the fallback page: a signer beyond Customer/Summit, or a proposal
 * template that carries neither the Acceptance page nor the Acknowledgment.
 */
function injectSignatureFields(
  bodyHtml: string,
  signers: SignerSpec[],
): { html: string; placedRoles: Set<string> } {
  const nonViewers = signers.filter((s) => !s.viewOnly);
  const customer = nonViewers.find((s) => s.role === CUSTOMER_ROLE) ?? nonViewers[0];
  const summit =
    nonViewers.find((s) => s.role === SUMMIT_ROLE && s !== customer) ??
    nonViewers.find((s) => s !== customer);

  let html = bodyHtml;
  const placedRoles = new Set<string>();

  const place = (signer: SignerSpec | undefined, slots: SignatureSlot[]): void => {
    if (!signer) return;
    for (const slot of slots) {
      const sig = fillSlot(
        html,
        slot.sigId,
        tag(`${slot.label} Signature`, signer.role, 'signature'),
      );
      html = sig.html;
      const date = fillSlot(html, slot.dateId, tag(`${slot.label} Date`, signer.role, 'date'));
      html = date.html;
      if (sig.placed || date.placed) placedRoles.add(signer.role);
    }
  };

  place(customer, CUSTOMER_SLOTS);
  place(summit, SUMMIT_SLOTS);

  return { html, placedRoles };
}

/** One signer's block: signature, printed name, optional title, date. */
function signerBlock(signer: SignerSpec): string {
  const role = signer.role;
  const label = signer.name ? `${signer.name}${signer.email ? ` — ${signer.email}` : ''}` : role;
  return `
    <div style="border: 1px solid #d4d4d4; padding: 18px 20px; margin-bottom: 18px;">
      <div style="font: 700 10pt/1.3 Georgia, 'Times New Roman', serif; letter-spacing: 0.06em; text-transform: uppercase; color: #555;">${escapeHtml(role)}</div>
      <div style="font: 400 10pt/1.4 Georgia, 'Times New Roman', serif; color: #555; margin-top: 2px;">${escapeHtml(label)}</div>
      <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; margin-top: 16px;">
        <div>
          <div style="min-height: 46px; font: 400 12pt/1.4 Georgia, serif;">${tag(`${role} Signature`, role, 'signature')}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Signature</div>
        </div>
        <div>
          <div style="min-height: 46px; font: 400 12pt/1.4 Georgia, serif;">${tag(`${role} Date`, role, 'date')}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Date</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; margin-top: 18px;">
        <div>
          <div style="min-height: 30px; font: 400 12pt/1.4 Georgia, serif;">${tag(`${role} Name`, role, 'text')}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Printed name</div>
        </div>
        <div>
          <div style="min-height: 30px; font: 400 12pt/1.4 Georgia, serif;">${
            signer.titleField === false
              ? ''
              : tag(`${role} Title`, role, 'text', { required: false })
          }</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Title</div>
        </div>
      </div>
    </div>`;
}

export function signaturePageHtml(input: AssemblyInput): string {
  const rows: string[] = [
    `<tr><th style="text-align:left;padding:6px 12px 6px 0;font:700 10pt/1.4 Georgia,serif;color:#555;">Proposal</th><td style="padding:6px 0;font:400 11pt/1.4 Georgia,serif;">${escapeHtml(input.proposalNumber)}</td></tr>`,
  ];
  if (input.proposalTitle)
    rows.push(
      `<tr><th style="text-align:left;padding:6px 12px 6px 0;font:700 10pt/1.4 Georgia,serif;color:#555;">Project</th><td style="padding:6px 0;font:400 11pt/1.4 Georgia,serif;">${escapeHtml(input.proposalTitle)}</td></tr>`,
    );
  if (input.customerName)
    rows.push(
      `<tr><th style="text-align:left;padding:6px 12px 6px 0;font:700 10pt/1.4 Georgia,serif;color:#555;">Client</th><td style="padding:6px 0;font:400 11pt/1.4 Georgia,serif;">${escapeHtml(input.customerName)}</td></tr>`,
    );
  if (typeof input.totalMinor === 'number')
    rows.push(
      `<tr><th style="text-align:left;padding:6px 12px 6px 0;font:700 10pt/1.4 Georgia,serif;color:#555;">Total</th><td style="padding:6px 0;font:700 11pt/1.4 Georgia,serif;">${money(input.totalMinor)}</td></tr>`,
    );

  const acceptance =
    input.acceptanceCopy ??
    'By signing below the client accepts this proposal, including the pricing, scope and any documents bound behind it, and authorizes Summit Sensory Gym to proceed.';

  // Viewers get no block — a block would carry signature/date/name tags, and a
  // tagged field is exactly what turns a DocuSeal submitter from a view-only
  // CC recipient into a required signer. They're still named on the page, in
  // words rather than fields, so the printed document itself shows who was
  // copied even though nothing here asks them to sign.
  const signers = input.signers.filter((s) => !s.viewOnly);
  const viewers = input.signers.filter((s) => s.viewOnly);
  const viewerLine = viewers.length
    ? `<p style="font: 400 9.5pt/1.5 Georgia, 'Times New Roman', serif; color: #666; margin-top: 4px;">Copied for reference, not required to sign: ${escapeHtml(
        viewers.map((v) => (v.name ? `${v.name} (${v.email})` : v.email)).join('; '),
      )}.</p>`
    : '';

  return `
  <section style="${PAGE_BREAK} padding-top: 8px;">
    <h2 style="font: 700 16pt/1.2 Georgia, 'Times New Roman', serif; margin: 0 0 4px;">Acceptance and signatures</h2>
    <table style="border-collapse: collapse; margin: 14px 0 20px;">${rows.join('')}</table>
    <p style="font: 400 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #333; max-width: 46em; text-wrap: pretty;">${escapeHtml(acceptance)}</p>
    ${viewerLine}
    ${signers
      .slice()
      .sort((a, b) => (a.order ?? 1) - (b.order ?? 1))
      .map(signerBlock)
      .join('')}
  </section>`;
}

/**
 * Clears the forced page break the proposal's own stylesheet puts after every
 * `.ssg-sheet` / `.ssg-fm-page`, including its last one.
 *
 * That break is correct when the sheet really is the last thing on the page —
 * true for the proposal on its own — and wrong here, where attachments and
 * the signature page follow it: left in place, it opens a blank sheet between
 * the proposal and whatever comes next.
 *
 * The proposal fixes this for itself with a small script, run once client-side,
 * that finds the true last sheet at render time (by document order, not by
 * `:last-child` — a CSS-only rule is exactly what this is not, since a wrapper
 * or a trailing element elsewhere in the tree defeats `:last-child` silently)
 * and clears its break with an inline style. `inlineDocument` strips every
 * `<script>` out of what gets merged into this package — attachments are not
 * necessarily this app's own markup, and a signing package is not where to
 * trust one to execute — so that fix never runs here. This is the same fix,
 * authored here rather than extracted from the input, scoped to run only
 * inside `#ssgProposalBody` so it cannot reach into an attachment's own markup.
 */
function trailingBreakFixScript(): string {
  return `<script>
  (function () {
    try {
      var root = document.getElementById('ssgProposalBody');
      var sheets = root ? root.querySelectorAll('.ssg-sheet, .ssg-fm-page') : [];
      if (!sheets.length) return;
      var last = sheets[sheets.length - 1];
      last.style.breakAfter = 'auto';
      last.style.pageBreakAfter = 'auto';
    } catch (e) {}
  })();
  <\/script>`;
}

/**
 * The whole package as one self-contained HTML document, ready for `renderPdf`.
 * Nothing here fetches from the network — same rule as the other rendered
 * documents, so a broken asset URL cannot hang a send.
 */
export function buildPackageHtml(input: AssemblyInput): string {
  const proposal = inlineDocument(input.proposalHtml);
  const attachments = (input.attachments ?? []).map((a) => {
    const frag = inlineDocument(a.bodyHtml);
    return {
      ...a,
      styles: frag.styles,
      body: `<section style="${PAGE_BREAK}">${frag.body}</section>`,
    };
  });

  // Field placement first: everyone whose role matches a real slot in the
  // proposal's own pages signs there. Only whoever is left — a signer beyond
  // Customer/Summit, or a proposal template carrying neither the Acceptance
  // page nor the Acknowledgment — gets a page generated for them, and that
  // page is skipped entirely when nobody needs it.
  const { html: proposalBody, placedRoles } = injectSignatureFields(proposal.body, input.signers);
  const unplacedSigners = input.signers.filter((s) => s.viewOnly || !placedRoles.has(s.role));
  const needsFallbackPage = unplacedSigners.some((s) => !s.viewOnly);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.proposalNumber)}</title>
<style>
  @page { size: Letter; }
  html, body { margin: 0; padding: 0; }
  body { font: 400 11pt/1.5 Georgia, 'Times New Roman', serif; color: #1a1a1a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table { border-collapse: collapse; }
</style>
${proposal.styles ? `<style>${proposal.styles}</style>` : ''}
${attachments.map((a) => (a.styles ? `<style>${a.styles}</style>` : '')).join('\n')}
</head>
<body>
<div id="ssgProposalBody">${proposalBody}</div>
${trailingBreakFixScript()}
${attachments.map((a) => a.body).join('\n')}
${needsFallbackPage ? signaturePageHtml({ ...input, signers: unplacedSigners }) : ''}
</body>
</html>`;
}

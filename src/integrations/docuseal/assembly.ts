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
 *   proposal body  →  attachment documents (in template sortOrder)  →  signature page
 *
 * The signature page carries DocuSeal TEXT TAGS. A tag is ordinary text in the PDF
 * that DocuSeal recognises and turns into a field:
 *
 *   {{Customer Signature;role=Customer;type=signature}}
 *
 * Field placement therefore lives in this layout rather than in stored coordinates,
 * which is what keeps a template edit from silently moving a signature box off the
 * page.
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

  return `
  <section style="${PAGE_BREAK} padding-top: 8px;">
    <h2 style="font: 700 16pt/1.2 Georgia, 'Times New Roman', serif; margin: 0 0 4px;">Acceptance and signatures</h2>
    <table style="border-collapse: collapse; margin: 14px 0 20px;">${rows.join('')}</table>
    <p style="font: 400 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #333; max-width: 46em; text-wrap: pretty;">${escapeHtml(acceptance)}</p>
    ${input.signers
      .slice()
      .sort((a, b) => (a.order ?? 1) - (b.order ?? 1))
      .map(signerBlock)
      .join('')}
  </section>`;
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
${proposal.body}
${attachments.map((a) => a.body).join('\n')}
${signaturePageHtml(input)}
</body>
</html>`;
}

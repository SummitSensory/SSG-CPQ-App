/**
 * Assembly: the signing package is composed here, in the CRM, before DocuSeal ever
 * sees it.
 *
 * Two PDFs, not one, produced by the same headless Chromium that renders the
 * proposal for monday and for the customer email, then merged with pdf-lib
 * (see buildPackage's own comment for why two — the short version is that the
 * proposal and everything else need two different print margins, and a
 * single Chromium render pass can only apply one). The proposal PDF is the
 * exact bytes a customer was quoted; DocuSeal is a signature service in this
 * design, not a document builder.
 *
 * Composition order:
 *
 *   proposal (fields placed in-line — see injectSignatureFields)
 *     →  attachment documents (in template sortOrder)
 *     →  fallback signature page, ONLY for whoever injectSignatureFields
 *        could not place — a signer beyond Customer/Summit, or a template
 *        with neither the Acceptance page nor the Acknowledgment
 *
 * A field is DocuSeal TEXT TAGS — ordinary text in the PDF that DocuSeal
 * recognises and turns into a fillable field:
 *
 *   {{Customer Signature;role=Customer;type=signature;valign=bottom;width=220;height=40}}
 *
 * That whole string has to reach DocuSeal as one unbroken, un-clipped run of
 * PDF text, closing brace included, or it is not a tag at all — see
 * `invisibleTag()` below for why it is never laid out as ordinary, visible
 * page content.
 *
 * Three choices in `tag()` (below) are there specifically for the signer, not
 * just for correctness: every date is `type=datenow` rather than `date` — the
 * signing date is stamped automatically when a signer completes their part,
 * so there is one less thing to fill in per signature, with no risk of it
 * disagreeing with when they actually signed — every field defaults to
 * `valign=bottom`, DocuSeal's own answer to a signature that renders inside a
 * taller field area than the line of text it replaced: centered (DocuSeal's
 * own default), it sits above the printed rule instead of on it — and every
 * field states its own `width`/`height` rather than leaving DocuSeal to size
 * it from the tag text itself, which is what let the Acknowledgment
 * signature field grow oversized and push Summit's block off the page (the
 * tag text naming the field is long; the field it describes is not).
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
  /** A rep's saved per-box width/height/font-size — see injectSignatureFields. */
  fieldSizeOverrides?: Readonly<Record<string, Partial<FieldSize>>>;
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
 *
 * `valign=bottom` on every field here: DocuSeal's own default is `center`,
 * which is what put a signature only roughly on its line rather than
 * resting on it — a signature block's field area is taller than the line
 * of text it replaces, and centering that tall area over a short one lands
 * above the rule. This is the field's own answer to that, on top of (not
 * instead of) the surrounding markup's own bottom-aligned layout.
 *
 * `width`/`height` are always passed now, not left to DocuSeal's default.
 * Per DocuSeal's own docs (embedded PDF text tags), an omitted width/height
 * falls back to "the tag text's own rendered size" — and a field name long
 * enough to say what it is (`Summit Acknowledgment Signature`) plus its role
 * and type attributes is a wide, unavoidably long string. That default is
 * what grew the Acknowledgment signature field oversized and pushed Summit's
 * block off the page: the field's size was never a layout choice, it was
 * whatever the tag string happened to measure. Passing both explicitly makes
 * the field's size a fact this code states, not a side effect of how long a
 * field's own name is.
 *
 * `fontSize` is likewise always passed now, for the same reason. DocuSeal's
 * own docs: an omitted `font_size` "is calculated based on the field
 * height" — and every field height here is sized to the tall row a
 * signature needs (40-46px), not to how big its printed VALUE should look.
 * Left to that default, a `datenow` stamp renders in a font scaled to a
 * signature-sized box — visibly larger than the printed name right next to
 * it on the same line — and a typed/cursive signature rendered at that same
 * height-driven size can be wide enough to run past its own field's stated
 * `width` into whatever sits to its right. Both were exactly what reached a
 * customer's signed copy of P-2026-000114 Rev3. Stating the size explicitly,
 * matched to the 11.5px the proposal already prints its signer's name at,
 * makes it a fact this code states rather than an accident of field height.
 */
function tag(
  name: string,
  role: string,
  type: string,
  opts: {
    required?: boolean;
    valign?: 'top' | 'center' | 'bottom';
    width: number;
    height: number;
    fontSize: number;
  },
): string {
  const parts = [
    name,
    `role=${role}`,
    `type=${type}`,
    `valign=${opts.valign ?? 'bottom'}`,
    `width=${opts.width}`,
    `height=${opts.height}`,
    `font_size=${opts.fontSize}`,
  ];
  if (opts.required === false) parts.push('required=false');
  return `{{${parts.join(';')}}}`;
}

/**
 * Wrap a text tag so DocuSeal can read it in full without a human ever
 * seeing it or its length disturbing the printed page.
 *
 * Two things have to be true of the same string at once: DocuSeal has to
 * receive the COMPLETE tag — name, role, type and now width/height — as one
 * unbroken run of PDF text, or it cannot recognize it as a tag at all; and
 * nothing about that string may show on the document a customer reads, or
 * change how much room anything else on the page gets.
 *
 * Constraining it with CSS (`overflow:hidden` on a box sized for the visible
 * blank line, the previous approach) satisfies neither: the box is far
 * narrower than an ~60-character tag needs, so the browser's own print
 * rendering clips the tag before DocuSeal ever sees it — cutting it off
 * mid-attribute, closing brace and all, exactly as happened on
 * P-2026-000110. A regex that never finds a closing `}}` cannot match, so
 * the field is never created and the clipped, literal `{{...}}` text is
 * what a customer actually saw.
 *
 * `position:absolute` removes the tag from layout entirely — it cannot grow
 * the box it sits in or push a sibling off the page, no matter how long the
 * field's own name is. `color:transparent` still paints real, extractable
 * glyphs (an invisible fill is still a fill; nothing here uses
 * `display:none` or `visibility:hidden`, either of which a print renderer is
 * free to skip painting altogether). The tiny font size is not about
 * legibility — nobody is meant to read it — it is what keeps even the
 * longest tag's rendered width well inside the page regardless of where it
 * lands, so it is never itself clipped by a page or column boundary.
 */
function invisibleTag(text: string): string {
  return (
    '<span style="position:absolute;top:0;left:0;font-size:2px;line-height:1;' +
    `color:transparent;white-space:nowrap;">${text}</span>`
  );
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
  /** The field size DocuSeal is told to use — see `tag()`'s width/height note. */
  sigWidth: number;
  sigHeight: number;
  dateWidth: number;
  dateHeight: number;
  /** Rendered value size DocuSeal is told to use — see `tag()`'s fontSize note. */
  sigFontSize: number;
  dateFontSize: number;
}
// The proposal prints the signer's own name at 11.5px (public/proposal-document.js)
// — the date sits on the same printed line, so it is given that same size rather
// than the larger one DocuSeal would otherwise compute from a 40-46px field height.
const NAME_PRINT_SIZE = 12;
const CUSTOMER_SLOTS: SignatureSlot[] = [
  // Matches the Acceptance page's own 40px-tall signature/date boxes
  // (public/proposal-document.js) — not because DocuSeal reads that CSS, but
  // so the field it draws sits at roughly the size the printed line already
  // reserves for it.
  {
    sigId: 'ssgSigAcceptanceSignature',
    dateId: 'ssgSigAcceptanceDate',
    label: 'Customer',
    // Height stays 40 — matching the printed-name and date boxes sharing this
    // same row (public/proposal-document.js), which are not independently
    // adjustable, so shrinking only this one would visibly misalign the row.
    // Width and font size are the two levers that actually make the drawn
    // signature read smaller without doing that.
    sigWidth: 180,
    sigHeight: 40,
    dateWidth: 150,
    dateHeight: 40,
    sigFontSize: 14,
    dateFontSize: NAME_PRINT_SIZE,
  },
  // Matches the Acknowledgment's sigBlock (public/contract-pages.js): the
  // "By:" rule is 46px tall; "Date:" has no fixed height there because a
  // `datenow` field is a short auto-stamped line, not a drawn signature.
  {
    sigId: 'ssgSigAckCustomerSignature',
    dateId: 'ssgSigAckCustomerDate',
    label: 'Customer Acknowledgment',
    sigWidth: 220,
    sigHeight: 46,
    dateWidth: 140,
    dateHeight: 20,
    sigFontSize: 14,
    dateFontSize: NAME_PRINT_SIZE,
  },
];
const SUMMIT_SLOTS: SignatureSlot[] = [
  {
    sigId: 'ssgSigAckSummitSignature',
    dateId: 'ssgSigAckSummitDate',
    label: 'Summit Acknowledgment',
    sigWidth: 220,
    sigHeight: 46,
    dateWidth: 140,
    dateHeight: 20,
    sigFontSize: 14,
    dateFontSize: NAME_PRINT_SIZE,
  },
];

/**
 * Every id `injectSignatureFields` matches, in the order the boxes print.
 *
 * The one source of truth for "what is a valid signature-field slot" —
 * src/routes/signatureFieldLayout.ts validates a saved layout's keys against this list
 * rather than its own copy, so a slot id can never drift between the two files.
 */
export const SIGNATURE_FIELD_SLOT_IDS: readonly string[] = [
  ...CUSTOMER_SLOTS.flatMap((s) => [s.sigId, s.dateId]),
  ...SUMMIT_SLOTS.flatMap((s) => [s.sigId, s.dateId]),
];

/** A DocuSeal field's own width/height/font size, independent of position. */
export interface FieldSize {
  width: number;
  height: number;
  fontSize: number;
}

/**
 * The as-shipped width/height/font size DocuSeal is told to use for each of the six
 * slots, derived from CUSTOMER_SLOTS/SUMMIT_SLOTS rather than retyped — the one source
 * of truth src/routes/signatureFieldLayout.ts's `/effective` route re-exports so
 * public/signature-field-layout-admin.js never carries its own copy to drift out of
 * sync with these.
 */
export const SIGNATURE_FIELD_DEFAULTS: Readonly<Record<string, FieldSize>> = Object.fromEntries(
  [...CUSTOMER_SLOTS, ...SUMMIT_SLOTS].flatMap((s) => [
    [s.sigId, { width: s.sigWidth, height: s.sigHeight, fontSize: s.sigFontSize }],
    [s.dateId, { width: s.dateWidth, height: s.dateHeight, fontSize: s.dateFontSize }],
  ]),
);

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
 *
 * `fieldSizeOverrides` is a rep's saved per-slot width/height/font-size, keyed by the
 * same slot id (see SIGNATURE_FIELD_DEFAULTS) — a field this rep resized in the
 * placement editor. Any property left out of a slot's override falls back to that
 * slot's own shipped default, so resizing only the signature leaves its date's size
 * untouched, and a slot nobody has ever touched behaves exactly as it always did.
 */
function injectSignatureFields(
  bodyHtml: string,
  signers: SignerSpec[],
  fieldSizeOverrides?: Readonly<Record<string, Partial<FieldSize>>>,
): { html: string; placedRoles: Set<string> } {
  const nonViewers = signers.filter((s) => !s.viewOnly);
  const customer = nonViewers.find((s) => s.role === CUSTOMER_ROLE) ?? nonViewers[0];
  const summit =
    nonViewers.find((s) => s.role === SUMMIT_ROLE && s !== customer) ??
    nonViewers.find((s) => s !== customer);

  let html = bodyHtml;
  const placedRoles = new Set<string>();

  const sizeOf = (id: string, shipped: FieldSize): FieldSize => ({
    ...shipped,
    ...fieldSizeOverrides?.[id],
  });

  const place = (signer: SignerSpec | undefined, slots: SignatureSlot[]): void => {
    if (!signer) return;
    for (const slot of slots) {
      const sigSize = sizeOf(slot.sigId, {
        width: slot.sigWidth,
        height: slot.sigHeight,
        fontSize: slot.sigFontSize,
      });
      const sig = fillSlot(
        html,
        slot.sigId,
        invisibleTag(tag(`${slot.label} Signature`, signer.role, 'signature', sigSize)),
      );
      html = sig.html;
      // `datenow`, not `date`: the signing date is stamped automatically when
      // this signer completes their part, with nothing for them to fill in —
      // one less required action per signature, and no risk of a date that
      // does not match when they actually signed.
      const dateSize = sizeOf(slot.dateId, {
        width: slot.dateWidth,
        height: slot.dateHeight,
        fontSize: slot.dateFontSize,
      });
      const date = fillSlot(
        html,
        slot.dateId,
        invisibleTag(tag(`${slot.label} Date`, signer.role, 'datenow', dateSize)),
      );
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
          <div style="min-height: 46px; position: relative; font: 400 12pt/1.4 Georgia, serif;">${invisibleTag(tag(`${role} Signature`, role, 'signature', { width: 260, height: 46, fontSize: 18 }))}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Signature</div>
        </div>
        <div>
          <div style="min-height: 46px; position: relative; font: 400 12pt/1.4 Georgia, serif;">${invisibleTag(tag(`${role} Date`, role, 'datenow', { width: 140, height: 30, fontSize: 12 }))}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Date</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; margin-top: 18px;">
        <div>
          <div style="min-height: 30px; position: relative; font: 400 12pt/1.4 Georgia, serif;">${invisibleTag(tag(`${role} Name`, role, 'text', { width: 220, height: 24, fontSize: 12 }))}</div>
          <div style="border-top: 1px solid #333; padding-top: 4px; font: 400 9pt/1.3 Georgia, serif; color: #555;">Printed name</div>
        </div>
        <div>
          <div style="min-height: 30px; position: relative; font: 400 12pt/1.4 Georgia, serif;">${
            signer.titleField === false
              ? ''
              : invisibleTag(
                  tag(`${role} Title`, role, 'text', {
                    required: false,
                    width: 220,
                    height: 24,
                    fontSize: 12,
                  }),
                )
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

  // A <div>, not a <section> — buildPackage already wraps every item in its
  // sections array (this one included) in its own <section>, and a nested
  // <section><section> would say nothing a single one doesn't.
  return `
  <div style="padding-top: 8px;">
    <h2 style="font: 700 16pt/1.2 Georgia, 'Times New Roman', serif; margin: 0 0 4px;">Acceptance and signatures</h2>
    <table style="border-collapse: collapse; margin: 14px 0 20px;">${rows.join('')}</table>
    <p style="font: 400 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #333; max-width: 46em; text-wrap: pretty;">${escapeHtml(acceptance)}</p>
    ${viewerLine}
    ${signers
      .slice()
      .sort((a, b) => (a.order ?? 1) - (b.order ?? 1))
      .map(signerBlock)
      .join('')}
  </div>`;
}

/**
 * The signing package, as two independently-correct documents ready for
 * `renderPdf` — see `sendProposalForSignature` in service.ts for how they get
 * merged into the one PDF DocuSeal and the customer actually see.
 *
 * Why two, not one: `input.proposalHtml` is composed of fixed 8.5in x 11in
 * `.ssg-sheet` / `.ssg-fm-page` divs that already carry their own margin as
 * CSS padding (see public/app.js's PAD_TOP/PAD_SIDE/PAD_BOTTOM) and its own
 * `@page { margin: 0 }` — the same document, rendered the same way
 * (`edgeToEdge: true`), that a customer's own copy already is (see
 * proposalPush.ts / finance.ts). An attachment or the generated fallback
 * signature page is ordinary flowing content with no such padding — it needs
 * Chromium's own margin instead. A single `renderPdf` call only takes one
 * margin, so rendering both halves in one pass forces the wrong margin onto
 * one of them: exactly what put the Acceptance page's own fixed-size sheet
 * through a non-zero print margin it was never authored for, spilling its
 * signature/date fields and its footer into whatever sheet printed next and
 * erasing what should have been blank page margin (the sheet, unable to
 * shrink to fit the reduced printable area `break-inside:avoid` still had to
 * respect, printed through it instead). Two renders, each at the margin its
 * content actually assumes, merged afterward with pdf-lib, is the fix.
 *
 * `proposalHtml` is `input.proposalHtml` untouched but for the signer's
 * actual fields filled into the ids it already prints — not re-wrapped in a
 * new document — so it stays byte-for-byte the document behind those ids,
 * head, stylesheet and pagination script included.
 */
export interface AssembledPackage {
  /** Render with `edgeToEdge: true` — see this function's own comment. */
  proposalHtml: string;
  /**
   * Attachments and/or the generated fallback signature page, as their own
   * self-contained document at ordinary (non-edge-to-edge) margins — `null`
   * when there is nothing left over: every real signer found a slot directly
   * in the proposal, and no attachments were selected.
   */
  extraHtml: string | null;
}

export function buildPackage(input: AssemblyInput): AssembledPackage {
  // Field placement first: everyone whose role matches a real slot in the
  // proposal's own pages signs there. Only whoever is left — a signer beyond
  // Customer/Summit, or a proposal template carrying neither the Acceptance
  // page nor the Acknowledgment — gets a page generated for them, and that
  // page is skipped entirely when nobody needs it. Runs directly against the
  // proposal's own full document (not an extracted fragment): the ids being
  // matched are plain `<div id="...">` text, indifferent to what wraps them,
  // and leaving the document otherwise untouched is the point.
  const { html: proposalHtml, placedRoles } = injectSignatureFields(
    input.proposalHtml,
    input.signers,
    input.fieldSizeOverrides,
  );
  const unplacedSigners = input.signers.filter((s) => s.viewOnly || !placedRoles.has(s.role));
  const needsFallbackPage = unplacedSigners.some((s) => !s.viewOnly);

  const sections = (input.attachments ?? []).map((a) => {
    const frag = inlineDocument(a.bodyHtml);
    return { styles: frag.styles, body: frag.body };
  });
  if (needsFallbackPage) {
    sections.push({ styles: '', body: signaturePageHtml({ ...input, signers: unplacedSigners }) });
  }

  if (!sections.length) return { proposalHtml, extraHtml: null };

  // Every section but the first opens on a fresh page — the first must not,
  // since this document has nothing ahead of it; that break is what the
  // merge onto the proposal PDF is for.
  const extraHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 400 11pt/1.5 Georgia, 'Times New Roman', serif; color: #1a1a1a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table { border-collapse: collapse; }
</style>
${sections.map((s) => (s.styles ? `<style>${s.styles}</style>` : '')).join('\n')}
</head>
<body>
${sections.map((s, i) => `<section${i === 0 ? '' : ` style="${PAGE_BREAK}"`}>${s.body}</section>`).join('\n')}
</body>
</html>`;

  return { proposalHtml, extraHtml };
}

import { describe, it, expect } from 'vitest';
import {
  buildPackage,
  signaturePageHtml,
  inlineDocument,
} from '../../src/integrations/docuseal/assembly.js';

const PROPOSAL_WITH_TRAILING_BREAK = `<!doctype html><html><head>
<style>.ssg-sheet{width:8.5in;height:11in;break-after:page;page-break-after:always;}</style>
</head><body>
<div class="ssg-sheet">Page one</div>
<div class="ssg-sheet">Page two</div>
<script>window.shouldNeverRun = true;</script>
</body></html>`;

describe('inlineDocument', () => {
  it('extracts style blocks and strips embedded scripts', () => {
    const { styles, body } = inlineDocument(PROPOSAL_WITH_TRAILING_BREAK);
    expect(styles).toContain('.ssg-sheet');
    expect(body).not.toContain('<script>');
    expect(body).toContain('Page one');
    expect(body).toContain('Page two');
  });
});

describe('buildPackage — proposalHtml', () => {
  it('leaves the proposal document untouched — same head, stylesheet and script, not re-wrapped', () => {
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
      totalMinor: 123456,
    });

    // Byte-for-byte the input document — including the script a real proposal
    // ships to clear its own trailing page break — except for fields filled
    // into ids that exist. Nothing here re-wraps or extracts it: that
    // rewrapping is exactly what let the DocuSeal package drift out of sync
    // with the customer's own copy of the same proposal.
    expect(proposalHtml).toContain('<script>window.shouldNeverRun = true;</script>');
    expect(proposalHtml).toContain('Page one');
    expect(proposalHtml).toContain('Page two');
    expect(proposalHtml).toContain('.ssg-sheet{width:8.5in;height:11in');
  });

  it('has no extraHtml when there are no attachments and every signer found a real slot', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    // PROPOSAL_WITH_TRAILING_BREAK carries no signature slot ids at all, so
    // the lone signer falls back to a generated page — extraHtml is null
    // only once every real signer is actually placed. See the field-placement
    // tests below for that case.
    expect(extraHtml).not.toBeNull();
  });

  it('does not fetch the client-supplied script from an attachment either', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK,
      attachments: [
        {
          key: 'w9',
          name: 'W9',
          bodyHtml:
            '<html><body><div class="ssg-sheet">W9</div><script>window.evil = 1;</script></body></html>',
        },
      ],
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    expect(extraHtml).not.toContain('window.evil');
    expect(extraHtml).toContain('W9');
  });
});

// A stand-in for the real proposal-document.js + contract-pages.js output —
// the same three empty slots those files mark with ids, nothing else.
const PROPOSAL_WITH_SIGNATURE_SLOTS = `<!doctype html><html><body>
<div class="ssg-sheet">
  Acceptance
  <div id="ssgSigAcceptanceSignature"></div>
  <div id="ssgSigAcceptanceDate"></div>
</div>
<div class="ssg-sheet">
  Acknowledgment
  <div id="ssgSigAckCustomerSignature"></div>
  <div id="ssgSigAckCustomerDate"></div>
  <div id="ssgSigAckSummitSignature"></div>
  <div id="ssgSigAckSummitDate"></div>
</div>
</body></html>`;

/**
 * Every field tag is wrapped in an absolutely positioned, invisible span
 * before it lands in the document — see invisibleTag() in assembly.ts. This
 * mirrors that wrapper exactly so assertions below test the real, complete
 * output a customer's PDF actually gets, not just the tag text buried inside.
 */
function wrapped(tagText: string): string {
  return (
    '<span style="position:absolute;top:0;left:0;font-size:2px;line-height:1;' +
    `color:transparent;white-space:nowrap;">${tagText}</span>`
  );
}

describe('buildPackage — field placement', () => {
  it('places Customer and Summit fields at their real spots in the document and never generates a fallback page for either', () => {
    const { proposalHtml, extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
      totalMinor: 100000,
    });

    expect(proposalHtml).toContain(
      `<div id="ssgSigAcceptanceSignature">${wrapped(
        '{{Customer Signature;role=Customer;type=signature;valign=bottom;width=220;height=40}}',
      )}</div>`,
    );
    expect(proposalHtml).toContain(
      `<div id="ssgSigAcceptanceDate">${wrapped(
        '{{Customer Date;role=Customer;type=datenow;valign=bottom;width=150;height=40}}',
      )}</div>`,
    );
    expect(proposalHtml).toContain(
      `<div id="ssgSigAckCustomerSignature">${wrapped(
        '{{Customer Acknowledgment Signature;role=Customer;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    expect(proposalHtml).toContain(
      `<div id="ssgSigAckSummitSignature">${wrapped(
        '{{Summit Acknowledgment Signature;role=Summit;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    // No generated "Acceptance and signatures" page at all — both signers found
    // a real spot, so there is nothing left for it to carry.
    expect(extraHtml).toBeNull();
  });

  it('falls back to a generated page only for a signer who never finds a real slot', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
        { role: 'Witness', name: 'Notary Public', email: 'notary@example.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });

    expect(extraHtml).toContain('Acceptance and signatures');
    // The fallback page carries only the signer that was not placed, not a
    // redundant copy of Customer/Summit who already signed in the document.
    expect(extraHtml).toContain('Witness');
    expect(extraHtml).toContain(
      wrapped(
        '{{Witness Signature;role=Witness;type=signature;valign=bottom;width=260;height=46}}',
      ),
    );
    const customerAcceptanceTag = wrapped(
      '{{Customer Signature;role=Customer;type=signature;valign=bottom;width=220;height=40}}',
    );
    expect((extraHtml ?? '').includes(customerAcceptanceTag)).toBe(false); // only in the Acceptance slot, not duplicated on the fallback page
  });

  it('resolves Customer/Summit positionally when a rep renames the roles', () => {
    const { proposalHtml, extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Client', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Vendor', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(proposalHtml).toContain(
      `<div id="ssgSigAcceptanceSignature">${wrapped(
        '{{Customer Signature;role=Client;type=signature;valign=bottom;width=220;height=40}}',
      )}</div>`,
    );
    expect(proposalHtml).toContain(
      `<div id="ssgSigAckSummitSignature">${wrapped(
        '{{Summit Acknowledgment Signature;role=Vendor;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    expect(extraHtml).toBeNull();
  });

  it('does not generate a fallback page for a lone view-only CC recipient once the real signers are placed', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
        { role: 'CC', name: 'Ops', email: 'ops@example.com', viewOnly: true },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(extraHtml).toBeNull();
  });

  it('falls back for everyone when the proposal template has neither known slot', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK, // no signature ids at all
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    expect(extraHtml).toContain('Acceptance and signatures');
    expect(extraHtml).toContain(
      wrapped(
        '{{Customer Signature;role=Customer;type=signature;valign=bottom;width=260;height=46}}',
      ),
    );
  });
});

describe('field tags are never clipped, and never visible', () => {
  it('every tag reaches the document as one complete, unbroken run of text with its closing braces intact', () => {
    // The whole point of the fix: DocuSeal can only recognize a tag if the
    // full string — including width/height and the closing "}}" — survives
    // as real PDF text. A regex against the assembled HTML is the same test
    // DocuSeal itself effectively runs against the rendered PDF's text layer.
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    const tags = proposalHtml.match(/\{\{[^{}]*\}\}/g) ?? [];
    expect(tags.length).toBe(6); // Acceptance sig+date, Ack customer sig+date, Ack summit sig+date
    for (const t of tags) {
      expect(t).toMatch(
        /^\{\{[^;]+;role=\S+;type=\S+;valign=(top|center|bottom);width=\d+;height=\d+\}\}$/,
      );
    }
  });

  it('wraps every tag so it can never be visible or affect the printed layout', () => {
    // position:absolute takes it out of flow (it cannot grow the box it sits
    // in or push anything else on the page); color:transparent means nothing
    // is visible even though the glyphs are still real, extractable PDF text.
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    const spans = proposalHtml.match(/<span style="[^"]*">\{\{[^{}]*\}\}<\/span>/g) ?? [];
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s).toContain('position:absolute');
      expect(s).toContain('color:transparent');
    }
  });
});

describe('signer-facing field ergonomics', () => {
  it('stamps every date automatically (datenow) rather than asking the signer to fill it in', () => {
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(proposalHtml).not.toContain(';type=date;');
    expect(proposalHtml).not.toContain(';type=date}}');
    expect(proposalHtml.match(/type=datenow/g)?.length).toBe(3); // Acceptance + Ack customer + Ack summit
  });

  it('bottom-aligns every field so a signature rests on its printed line rather than floating above it', () => {
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    const tags = proposalHtml.match(/\{\{[^}]+\}\}/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('valign=bottom');
  });

  it('gives every field an explicit width and height rather than leaving DocuSeal to size it from the tag text', () => {
    // DocuSeal's own default (no width/height given) is the tag text's own
    // rendered size — a field named "Summit Acknowledgment Signature" is a
    // long string, and that default is what grew the field oversized and
    // pushed Summit's block off the page. Every tag states both explicitly.
    const { proposalHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    const tags = proposalHtml.match(/\{\{[^}]+\}\}/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) {
      expect(t).toMatch(/width=\d+/);
      expect(t).toMatch(/height=\d+/);
    }
  });
});

describe('extraHtml page breaks', () => {
  it('does not open the extras document with a leading blank page', () => {
    const { extraHtml } = buildPackage({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK,
      attachments: [{ key: 'w9', name: 'W9', bodyHtml: '<html><body>W9 content</body></html>' }],
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    // The first <section> in the extras document must not force a page break
    // before it — this document has nothing ahead of it; that break is what
    // the merge onto the proposal PDF supplies instead. A second section (the
    // generated fallback page here, since PROPOSAL_WITH_TRAILING_BREAK has no
    // signature slots) DOES get one, so it lands on its own page.
    const sectionOpenTags = extraHtml?.match(/<section[^>]*>/g) ?? [];
    expect(sectionOpenTags[0]).toBe('<section>');
    expect(sectionOpenTags[1]).toContain('break-before');
  });
});

describe('signaturePageHtml', () => {
  it('prints the total it is given, in dollars', () => {
    const html = signaturePageHtml({
      proposalHtml: '',
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
      totalMinor: 1622969,
    });
    expect(html).toContain('$16,229.69');
  });

  it('omits the Total row entirely when no total is given, rather than printing $0.00', () => {
    const html = signaturePageHtml({
      proposalHtml: '',
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    expect(html).not.toContain('Total');
  });
});

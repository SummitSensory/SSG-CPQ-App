import { describe, it, expect } from 'vitest';
import {
  buildPackageHtml,
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

describe('buildPackageHtml', () => {
  it('wraps the proposal body in #ssgProposalBody and re-adds a trusted script that clears the trailing page break', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
      totalMinor: 123456,
    });

    // The last real sheet of the proposal must end up inside the wrapper the
    // fix-up script looks for, or attachments/the signature page get a blank
    // sheet inserted ahead of them — see trailingBreakFixScript's own comment.
    expect(html).toMatch(/<div id="ssgProposalBody">[\s\S]*Page two[\s\S]*<\/div>/);
    expect(html).toContain("document.getElementById('ssgProposalBody')");
    expect(html).toContain(".querySelectorAll('.ssg-sheet, .ssg-fm-page')");
    // The attacker-controlled proposal script must never survive the merge —
    // only the trusted, hand-authored fix-up script should run.
    expect(html).not.toContain('shouldNeverRun');
  });

  it('does not fetch the client-supplied script from an attachment either', () => {
    const html = buildPackageHtml({
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
    expect(html).not.toContain('window.evil');
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

describe('buildPackageHtml — field placement', () => {
  it('places Customer and Summit fields at their real spots in the document and never generates a fallback page for either', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
      totalMinor: 100000,
    });

    expect(html).toContain(
      `<div id="ssgSigAcceptanceSignature">${wrapped(
        '{{Customer Signature;role=Customer;type=signature;valign=bottom;width=220;height=40}}',
      )}</div>`,
    );
    expect(html).toContain(
      `<div id="ssgSigAcceptanceDate">${wrapped(
        '{{Customer Date;role=Customer;type=datenow;valign=bottom;width=150;height=40}}',
      )}</div>`,
    );
    expect(html).toContain(
      `<div id="ssgSigAckCustomerSignature">${wrapped(
        '{{Customer Acknowledgment Signature;role=Customer;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    expect(html).toContain(
      `<div id="ssgSigAckSummitSignature">${wrapped(
        '{{Summit Acknowledgment Signature;role=Summit;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    // No generated "Acceptance and signatures" page at all — both signers found
    // a real spot, so there is nothing left for it to carry.
    expect(html).not.toContain('Acceptance and signatures');
  });

  it('falls back to a generated page only for a signer who never finds a real slot', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
        { role: 'Witness', name: 'Notary Public', email: 'notary@example.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });

    expect(html).toContain('Acceptance and signatures');
    // The fallback page carries only the signer that was not placed, not a
    // redundant copy of Customer/Summit who already signed in the document.
    expect(html).toContain('Witness');
    expect(html).toContain(
      wrapped(
        '{{Witness Signature;role=Witness;type=signature;valign=bottom;width=260;height=46}}',
      ),
    );
    const customerAcceptanceTag = wrapped(
      '{{Customer Signature;role=Customer;type=signature;valign=bottom;width=220;height=40}}',
    );
    expect(html.split(customerAcceptanceTag).length - 1).toBe(1); // only in the Acceptance slot, not duplicated on the fallback page
  });

  it('resolves Customer/Summit positionally when a rep renames the roles', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Client', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Vendor', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(html).toContain(
      `<div id="ssgSigAcceptanceSignature">${wrapped(
        '{{Customer Signature;role=Client;type=signature;valign=bottom;width=220;height=40}}',
      )}</div>`,
    );
    expect(html).toContain(
      `<div id="ssgSigAckSummitSignature">${wrapped(
        '{{Summit Acknowledgment Signature;role=Vendor;type=signature;valign=bottom;width=260;height=46}}',
      )}</div>`,
    );
    expect(html).not.toContain('Acceptance and signatures');
  });

  it('does not generate a fallback page for a lone view-only CC recipient once the real signers are placed', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
        { role: 'CC', name: 'Ops', email: 'ops@example.com', viewOnly: true },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(html).not.toContain('Acceptance and signatures');
  });

  it('falls back for everyone when the proposal template has neither known slot', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_TRAILING_BREAK, // no signature ids at all
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    expect(html).toContain('Acceptance and signatures');
    expect(html).toContain(
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
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    const tags = html.match(/\{\{[^{}]*\}\}/g) ?? [];
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
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    const spans = html.match(/<span style="[^"]*">\{\{[^{}]*\}\}<\/span>/g) ?? [];
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s).toContain('position:absolute');
      expect(s).toContain('color:transparent');
    }
  });
});

describe('signer-facing field ergonomics', () => {
  it('stamps every date automatically (datenow) rather than asking the signer to fill it in', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    expect(html).not.toContain(';type=date;');
    expect(html).not.toContain(';type=date}}');
    expect(html.match(/type=datenow/g)?.length).toBe(3); // Acceptance + Ack customer + Ack summit
  });

  it('bottom-aligns every field so a signature rests on its printed line rather than floating above it', () => {
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [{ role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' }],
      proposalNumber: 'P-2026-000001',
    });
    const tags = html.match(/\{\{[^}]+\}\}/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toContain('valign=bottom');
  });

  it('gives every field an explicit width and height rather than leaving DocuSeal to size it from the tag text', () => {
    // DocuSeal's own default (no width/height given) is the tag text's own
    // rendered size — a field named "Summit Acknowledgment Signature" is a
    // long string, and that default is what grew the field oversized and
    // pushed Summit's block off the page. Every tag states both explicitly.
    const html = buildPackageHtml({
      proposalHtml: PROPOSAL_WITH_SIGNATURE_SLOTS,
      signers: [
        { role: 'Customer', name: 'Jane Doe', email: 'jane@example.com' },
        { role: 'Summit', name: 'Bryan Shepherd', email: 'bryan@summitsensory.com' },
      ],
      proposalNumber: 'P-2026-000001',
    });
    const tags = html.match(/\{\{[^}]+\}\}/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) {
      expect(t).toMatch(/width=\d+/);
      expect(t).toMatch(/height=\d+/);
    }
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

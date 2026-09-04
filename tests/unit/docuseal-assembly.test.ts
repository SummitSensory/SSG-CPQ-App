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
      '<div id="ssgSigAcceptanceSignature">{{Customer Signature;role=Customer;type=signature}}</div>',
    );
    expect(html).toContain(
      '<div id="ssgSigAcceptanceDate">{{Customer Date;role=Customer;type=date}}</div>',
    );
    expect(html).toContain(
      '<div id="ssgSigAckCustomerSignature">{{Customer Acknowledgment Signature;role=Customer;type=signature}}</div>',
    );
    expect(html).toContain(
      '<div id="ssgSigAckSummitSignature">{{Summit Acknowledgment Signature;role=Summit;type=signature}}</div>',
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
    expect(html).toContain('{{Witness Signature;role=Witness;type=signature}}');
    const customerFallbackTag = '{{Customer Signature;role=Customer;type=signature}}';
    expect(html.split(customerFallbackTag).length - 1).toBe(1); // only in the Acceptance slot, not duplicated on the fallback page
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
      '<div id="ssgSigAcceptanceSignature">{{Customer Signature;role=Client;type=signature}}</div>',
    );
    expect(html).toContain(
      '<div id="ssgSigAckSummitSignature">{{Summit Acknowledgment Signature;role=Vendor;type=signature}}</div>',
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
    expect(html).toContain('{{Customer Signature;role=Customer;type=signature}}');
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

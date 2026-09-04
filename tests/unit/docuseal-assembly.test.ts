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

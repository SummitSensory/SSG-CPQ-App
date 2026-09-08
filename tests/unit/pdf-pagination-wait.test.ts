import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * public/app.js's `proposalStandaloneHtml` ships its own pagination as an inline
 * `<script>`, gated behind the async `document.fonts.ready` — there is no relationship
 * between that and Playwright's `domcontentloaded`, so a page can be captured before
 * the script has actually built the real page breaks, margins and footer. That is what
 * produced a DocuSeal signing package with no top margin and no page footer on a real,
 * completed proposal even though the same document's own PDF download printed
 * correctly. renderPdf must wait for the script's own completion signal
 * (`data-paginated="1"`) before calling page.pdf() — but only for documents that
 * actually ship that script; everything else (an attachment, the certificate page)
 * must render exactly as fast as it always did.
 *
 * `vi.mock` here, not `vi.doMock` inside a `beforeEach` with `vi.resetModules()`: the
 * latter is NOT hoisted, and under the full suite's own parallel load — where another
 * test file may have already really imported 'playwright-core' in the same worker —
 * it intermittently failed to intercept pdf.ts's own dynamic `import('playwright-core')`
 * at all, letting a REAL headless Chromium launch instead of this fake one. `vi.mock`
 * is hoisted above every import in this file by Vitest's own transform, which is what
 * actually guarantees the mock is in place before pdf.ts ever asks for the module.
 */
const waitForFunction = vi.fn().mockResolvedValue(undefined);
const page = {
  setContent: vi.fn().mockResolvedValue(undefined),
  emulateMedia: vi.fn().mockResolvedValue(undefined),
  pdf: vi.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
  close: vi.fn().mockResolvedValue(undefined),
  waitForFunction,
};
const browser = {
  newPage: vi.fn().mockResolvedValue(page),
  close: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
};

vi.mock('playwright-core', () => ({
  chromium: { launch: vi.fn().mockResolvedValue(browser) },
}));

const { renderPdf } = await import('../../src/render/pdf.js');

describe('renderPdf — pagination wait', () => {
  beforeEach(() => {
    // The browser/page are cached at module scope in pdf.ts across every test in
    // this file (matching production, where a warm container reuses one browser) —
    // only the per-call spies need resetting between tests, not the module graph.
    waitForFunction.mockClear();
    page.setContent.mockClear();
    page.pdf.mockClear();
  });

  it('waits for the pagination script to signal completion when the document ships one', async () => {
    const html =
      '<html><body><div id="propPrintArea"></div>' +
      '<script>function paginateProposalArea(root){}(function(){})();</script></body></html>';

    await renderPdf(html, { edgeToEdge: true });

    expect(waitForFunction).toHaveBeenCalledTimes(1);
    expect(String(waitForFunction.mock.calls[0]?.[0])).toContain('data-paginated');
  });

  it('does not wait at all for a document with no pagination script — an attachment, the certificate page', async () => {
    const html = '<html><body><p>Plain content, no pagination.</p></body></html>';

    await renderPdf(html, { edgeToEdge: true });

    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it('still returns a PDF even if the pagination signal never arrives, rather than failing the render', async () => {
    waitForFunction.mockRejectedValueOnce(new Error('timeout'));
    const html = '<html><body><script>paginateProposalArea</script></body></html>';

    const bytes = await renderPdf(html, { edgeToEdge: true });

    expect(bytes.toString()).toBe('pdf-bytes');
  });
});

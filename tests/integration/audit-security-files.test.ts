import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * Security audit — stored-file paths and the PDF renderer's local-asset inliner.
 *
 *  - Every blob pathname built from user input (order number, vendor, filename) must
 *    stay inside its folder: no separators, no `..`, no leading dot.
 *  - inlineKnownAssets turns `<img src>` paths into data URIs by reading disk; it must
 *    never read outside public/.
 *  - getFile sends the Blob read-write token with the request; it must only ever send
 *    it to Vercel Blob.
 */
vi.hoisted(() => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_audit_placeholder';
});

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

const NASTY = [
  '../../etc/passwd',
  '..\\..\\windows\\win.ini',
  '/absolute/path',
  '....//....//x',
  '%2e%2e%2fsecret',
  '.env',
  'a/../../b',
  'C:\\boot.ini',
  '\u0000evil',
  'ｆｕｌｌ／ｗｉｄｔｈ',
];

describe('blob pathnames built from user input', () => {
  it.each(NASTY)('safeSegment(%j) is a single, non-hidden segment', async (input) => {
    const { safeSegment } = await import('../../src/lib/fileStore.js');
    const s = safeSegment(input);
    expect(s).not.toMatch(/[/\\]/);
    expect(s).not.toMatch(/^\./);
    // `a-..-b` is harmless inside one segment; only a whole `.`/`..` segment walks.
    expect(['.', '..']).not.toContain(s);
    expect(s).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it.each(NASTY)(
    'purchase-order / reference / BOM paths stay in their folder for %j',
    async (x) => {
      const { purchaseOrderPath, referenceDocumentPath } =
        await import('../../src/lib/fileStore.js');
      const { bomFilePath } = await import('../../src/handoff/bomFiles.js');
      const po = purchaseOrderPath({ orderNumber: x, fileId: 'f1', filename: x });
      expect(po.split('/')).toHaveLength(3);
      expect(po.startsWith('purchase-orders/')).toBe(true);
      const ref = referenceDocumentPath({ fileId: 'f1', filename: x });
      expect(ref.split('/')).toHaveLength(2);
      const bom = bomFilePath({ orderNumber: x, vendor: x, fileId: 'f1', filename: x });
      expect(bom.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')).toBe(false);
    },
  );
});

describe('PDF renderer local-asset inliner', () => {
  let dir: string;
  let outside: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-inline-'));
    outside = join(dir, 'secret.png');
    writeFileSync(outside, 'NOT-A-PUBLIC-ASSET');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('inlines a real public asset (control)', async () => {
    const { inlineKnownAssets } = await import('../../src/render/pdf.js');
    const out = await inlineKnownAssets('<img src="/favicon-16.png">');
    expect(out).toContain('src="data:image/png;base64,');
  });

  it('does not read an image-named file outside public/ via ../ traversal', async () => {
    const { inlineKnownAssets } = await import('../../src/render/pdf.js');
    const rel = relative(join(process.cwd(), 'public'), outside).replace(/\\/g, '/');
    expect(rel.startsWith('..')).toBe(true);
    for (const src of [rel, '/' + rel, rel.replace(/\//g, '\\')]) {
      const html = `<img src="${src}">`;
      const out = await inlineKnownAssets(html);
      expect(out, src).toBe(html);
      expect(out).not.toContain(Buffer.from('NOT-A-PUBLIC-ASSET').toString('base64'));
    }
  });

  it('does not read an absolute path or a file:// URL', async () => {
    const { inlineKnownAssets } = await import('../../src/render/pdf.js');
    for (const src of [outside, 'file:///' + outside.replace(/\\/g, '/')]) {
      const html = `<img src="${src}">`;
      expect(await inlineKnownAssets(html), src).toBe(html);
    }
  });
});

describe('blob read-back sends its token only to Vercel Blob', () => {
  it('sends the token to the store (control)', async () => {
    const { getFile } = await import('../../src/lib/fileStore.js');
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await getFile('https://abc.private.blob.vercel-storage.com/bom-files/x.pdf', fetchImpl);
    expect(seen[0]!.auth).toMatch(/^Bearer /);
  });

  // FINDING (medium): getFile (src/lib/fileStore.ts:151) attaches
  // `Authorization: Bearer BLOB_READ_WRITE_TOKEN` to whatever URL the row holds, and
  // two routes store a URL the BROWSER supplied (recordBomFile, src/handoff/bomFiles.ts:163;
  // proposal renderings, src/routes/proposalRenderings.ts:134) rather than the canonical
  // `url` that blob head() returned. head() is keyed on the URL's pathname, so a
  // HANDOFF_MANAGE / PROPOSAL_WRITE user who records `https://attacker.example/<their
  // own real pathname>` and then clicks Download hands the store-wide read-write token
  // to attacker.example (whether Vercel's head() ignores the host is unverified; the
  // client is trusted either way). Fix: persist info.url from head(), and have getFile
  // refuse any host that is not *.blob.vercel-storage.com.
  it.fails('never sends the token to a non-Vercel host', async () => {
    const { getFile } = await import('../../src/lib/fileStore.js');
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)?.Authorization);
      return new Response('ok');
    }) as unknown as typeof fetch;
    await getFile('https://attacker.example/bom-files/1/v/f.pdf', fetchImpl).catch(() => null);
    expect(seen.filter(Boolean)).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { appendPdfDocuments } from '../../src/lib/pdfMerge.js';

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('appendPdfDocuments', () => {
  it('returns the base document unchanged when there is nothing to append', async () => {
    const base = await makePdf(2);
    const out = await appendPdfDocuments(base, []);
    expect(out).toBe(base);
  });

  it('appends every page of every extra document, in order', async () => {
    const base = await makePdf(3);
    const w9 = await makePdf(1);
    const coi = await makePdf(2);
    const merged = await appendPdfDocuments(base, [
      { name: 'w9.pdf', bytes: w9 },
      { name: 'coi.pdf', bytes: coi },
    ]);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(3 + 1 + 2);
  });

  it('skips a corrupt extra document instead of failing the whole merge', async () => {
    const base = await makePdf(2);
    const merged = await appendPdfDocuments(base, [
      { name: 'not-a-pdf.pdf', bytes: Buffer.from('this is not a pdf') },
    ]);
    const doc = await PDFDocument.load(merged);
    // The base document's own pages survive even though the one extra was unusable —
    // a bad reference document must not block sending the proposal itself.
    expect(doc.getPageCount()).toBe(2);
  });

  it('does not mutate the caller-supplied base buffer', async () => {
    const base = await makePdf(1);
    const original = Buffer.from(base);
    await appendPdfDocuments(base, [{ name: 'x.pdf', bytes: await makePdf(1) }]);
    expect(base.equals(original)).toBe(true);
  });
});

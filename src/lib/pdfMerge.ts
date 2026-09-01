import { PDFDocument } from 'pdf-lib';
import { logger } from './logger.js';

/**
 * Append other people's PDFs onto ours, unmodified.
 *
 * The proposal PDF is produced by rendering our own HTML — we control every byte of
 * it. A reference document (a W9, a certificate of insurance) is not: it arrives as
 * someone else's finished PDF, and the whole point of attaching it is that it prints
 * exactly as it was uploaded, not re-typeset through our renderer. That is a real
 * merge of two PDF documents' page trees, not a bigger HTML page — hence pdf-lib
 * rather than another pass through Chromium.
 *
 * A page that fails to copy is skipped and logged rather than failing the whole
 * merge: the base document is the one with the price and the signature block on it,
 * and a reference document that turned out to be corrupt should not block sending
 * the proposal itself.
 */
export async function appendPdfDocuments(
  baseBytes: Buffer,
  extras: Array<{ name: string; bytes: Buffer }>,
): Promise<Buffer> {
  if (!extras.length) return baseBytes;

  const base = await PDFDocument.load(baseBytes);

  for (const extra of extras) {
    try {
      const doc = await PDFDocument.load(extra.bytes);
      const pages = await base.copyPages(doc, doc.getPageIndices());
      for (const page of pages) base.addPage(page);
    } catch (err) {
      logger.error({ err, name: extra.name }, 'pdfMerge: could not append reference document');
    }
  }

  return Buffer.from(await base.save());
}

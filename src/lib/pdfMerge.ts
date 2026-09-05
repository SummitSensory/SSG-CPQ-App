import { PDFDocument, PageSizes } from 'pdf-lib';
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

/**
 * Append images as full pages, each scaled to fit a Letter page with a half-inch
 * margin and centered — a design rendering is normally a photo or a screen
 * capture from CAD software, not something drawn at page-print proportions, so
 * scale-to-fit reads better than stretching or cropping to the page's aspect
 * ratio.
 *
 * A PDF among the same batch of uploads is merged as its own pages via
 * appendPdfDocuments instead — this function is image formats only.
 */
export async function appendImagePages(
  baseBytes: Buffer,
  images: Array<{ name: string; bytes: Buffer; contentType: string }>,
): Promise<Buffer> {
  if (!images.length) return baseBytes;

  const base = await PDFDocument.load(baseBytes);
  const [pageWidth, pageHeight] = PageSizes.Letter;
  const margin = 36; // half an inch

  for (const image of images) {
    try {
      const embedded = /jpe?g/i.test(image.contentType)
        ? await base.embedJpg(image.bytes)
        : await base.embedPng(image.bytes);
      const maxWidth = pageWidth - margin * 2;
      const maxHeight = pageHeight - margin * 2;
      const scale = Math.min(maxWidth / embedded.width, maxHeight / embedded.height, 1);
      const width = embedded.width * scale;
      const height = embedded.height * scale;
      const page = base.addPage([pageWidth, pageHeight]);
      page.drawImage(embedded, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height,
      });
    } catch (err) {
      logger.error({ err, name: image.name }, 'pdfMerge: could not append rendering image');
    }
  }

  return Buffer.from(await base.save());
}

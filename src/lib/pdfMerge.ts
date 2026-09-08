import { PDFDocument, PageSizes, StandardFonts, rgb } from 'pdf-lib';
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
 * Stamp a small reference line in the bottom-left corner of every page of the
 * fully-assembled signed package — proof a customer received every page of
 * what they signed, not just the ones a signature field happened to land on.
 *
 * Deliberately the LAST step in storeSignedCopy, after every merge (the
 * signed proposal pages, then the Certificate of Signature): stamping the
 * already-finished PDF's own page tree reaches every page regardless of
 * which renderer produced it, including a third-party reference document (a
 * W9, a certificate of insurance) that carries no branding of its own and
 * that HTML-level footer logic could never reach.
 *
 * A page a stamp fails to draw on is skipped and logged rather than failing
 * the whole store — the signed copy itself existing matters far more than
 * every one of its pages carrying this mark.
 */
export async function stampPageReferences(bytes: Buffer, reference: string): Promise<Buffer> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = 6.5;
  for (const page of doc.getPages()) {
    try {
      page.drawText(reference, {
        x: 18,
        y: 14,
        size: fontSize,
        font,
        // Dark enough to actually read once printed or scanned — the whole
        // point of this stamp is to be checkable, not merely present — but
        // still visually secondary to the page's own real content.
        color: rgb(0.3, 0.3, 0.3),
      });
    } catch (err) {
      logger.warn({ err }, 'pdfMerge: could not stamp a page reference');
    }
  }
  return Buffer.from(await doc.save());
}

/**
 * Merge one PDF this app just rendered onto another it also just rendered —
 * e.g. the DocuSeal package's proposal and its attachments/fallback-signature
 * document (see buildPackage in docuseal/assembly.ts). Unlike
 * appendPdfDocuments, a failure here THROWS instead of being logged and
 * skipped.
 *
 * appendPdfDocuments' tolerate-and-skip behavior is correct for a reference
 * document someone else produced (a W9 that turned out to be corrupt should
 * not block sending the proposal it rides along with) — it is wrong here: a
 * fresh Chromium render is never the "corrupt third-party PDF" that
 * justified tolerating a merge failure, and this content is not optional
 * supplementary material. For a signer beyond Customer/Summit, the
 * attachments/fallback document IS their only signature field — silently
 * dropping it would send a document DocuSeal creates a submitter for but
 * that has nothing for them to sign, with nothing surfacing the failure.
 */
export async function mergeRenderedPdfs(baseBytes: Buffer, extraBytes: Buffer): Promise<Buffer> {
  const base = await PDFDocument.load(baseBytes);
  const extra = await PDFDocument.load(extraBytes);
  const pages = await base.copyPages(extra, extra.getPageIndices());
  for (const page of pages) base.addPage(page);
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

import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  renderBomHtml,
  renderBomXlsx,
  renderBomCsv,
  bomFilename,
} from '../handoff/bomDocuments.js';
import { uploadProposalPdfToMonday } from '../integrations/monday/proposalPush.js';
import { renderPdf, pdfAvailable, warmRenderer } from '../render/pdf.js';
import { checkDocumentTotal } from '../proposals/documentIntegrity.js';
import { enforceOrReport } from '../lib/guards.js';
import { sellerCollectedCharges } from '../crossborder/sellerCharges.js';
import { appendPdfDocuments, setPdfTitle } from '../lib/pdfMerge.js';
import { resolveReferenceDocuments } from '../proposals/referenceDocuments.js';

/**
 * Server-rendered PDFs.
 *
 * Everything under /render/* is routed to its own serverless function so it can
 * be given the memory and time headless Chromium needs without charging every
 * other request for it — see vercel.json.
 */
export function registerRenderRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const release = { preHandler: requirePermission(Permission.PROPOSAL_RELEASE) };
  const proposalRead = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * The released proposal, rendered and dropped into the monday deal row's file
   * column.
   *
   * Split out of the release call deliberately. Release runs on the main API
   * function, which has 30 seconds and no headroom for a cold headless browser —
   * the PDF either never rendered or took the whole request down with it, and the
   * deal board ended up with the numbers but no document. Here it gets the
   * renderer's memory and its 180-second ceiling.
   */
  app.post('/render/proposals/versions/:versionId/monday-file', release, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = (req.body ?? {}) as { proposalHtml?: string; filename?: string };
    if (!body.proposalHtml)
      throw new ValidationError('The rendered proposal is missing from the request.');
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not available on this deployment.');
    }
    // The document is rendered by the browser and posted here, so a stale tab or a
    // hand-edited payload could put a PDF on the deal board whose bottom line is not
    // the proposal's. Refused rather than uploaded — see proposals/documentIntegrity.ts.
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { items: true, sections: true },
    });
    if (!version) throw new ValidationError('Proposal version not found');
    const border = await sellerCollectedCharges(versionId);
    const check = checkDocumentTotal(
      body.proposalHtml,
      version.items,
      version.sections,
      border.totalMinor,
    );
    if (!check.ok) {
      enforceOrReport(
        'monday-document-total',
        { versionId, expected: check.expected, expectedMinor: check.expectedMinor },
        () =>
          new ValidationError(
            `This document does not match the saved proposal (its total should be ${check.expected}). Reload the proposal and try again.`,
          ),
      );
    }
    return uploadProposalPdfToMonday({
      versionId,
      proposalHtml: body.proposalHtml,
      filename: body.filename,
    });
  });

  /**
   * "Save PDF" from the proposal preview and the builder: the document on screen,
   * rendered HERE and returned as a download.
   *
   * It used to be the browser's own print dialog (window.print → Save as PDF), and
   * that made the PDF depend on the rep's print settings. Chrome remembers its Scale
   * choice between prints; left on "Fit to page width" it lays the page out at the
   * browser window's width and scales that onto the paper, so a proposal pinned to
   * 8.5in came out shrunk into the top-left corner by (816 / window width) — e.g.
   * P-2026-000160 on 2026-09-24, printed at 76%. Nothing the document's CSS does can
   * override that setting. The server renderer has no such setting: this is the same
   * render, geometry and reference-document merge the monday file and the DocuSeal
   * package use, so every copy of a proposal is the same document.
   *
   * No total check against the saved version, unlike monday-file: this is also the
   * builder's download of unsaved work, and it goes to the person who asked for it,
   * not to a customer or the deal board.
   */
  app.post('/render/proposals/document.pdf', proposalRead, async (req, reply) => {
    const body = (req.body ?? {}) as {
      proposalHtml?: unknown;
      filename?: unknown;
      referenceDocKeys?: unknown;
    };
    if (typeof body.proposalHtml !== 'string' || !body.proposalHtml)
      throw new ValidationError('The rendered proposal is missing from the request.');
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not available on this deployment.');
    }
    const keys = Array.isArray(body.referenceDocKeys)
      ? body.referenceDocKeys.filter((k): k is string => typeof k === 'string').slice(0, 20)
      : [];
    let pdf = await renderPdf(body.proposalHtml, { format: 'Letter', edgeToEdge: true });
    // Only active documents from the library resolve — a key from the page cannot
    // pull in anything else. A document that cannot be read (storage unreachable)
    // does not cost the rep the proposal itself: it goes out without it and the
    // response says so, and the page tells them — rather than failing the download
    // and dropping them back into the browser print this route exists to replace.
    let missingReferenceDocs = false;
    if (keys.length) {
      try {
        pdf = await appendPdfDocuments(pdf, await resolveReferenceDocuments(keys));
      } catch (err) {
        missingReferenceDocs = true;
        req.log.warn({ err, keys }, 'proposal pdf: reference documents could not be attached');
      }
    }
    if (missingReferenceDocs) reply.header('X-Reference-Docs-Missing', '1');
    const name =
      String(typeof body.filename === 'string' ? body.filename : 'Proposal')
        .replace(/\.pdf$/i, '')
        .replace(/[^\w .,()&'-]+/g, '')
        .trim()
        .slice(0, 150) || 'Proposal';
    // The preview's Print prints this same PDF, and Chrome's print dialog names a
    // printed PDF after its Title — so the Title is the file name Save PDF downloads
    // under. See setPdfTitle.
    pdf = await setPdfTitle(pdf, name);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${name}.pdf"`)
      .send(pdf);
  });

  /**
   * Start Chromium in this function before it is needed. The proposal preview calls
   * it the moment it opens, so the cold start (several seconds on a fresh container)
   * is paid while the rep is still reading, not after they press Save PDF or Print.
   */
  app.get('/render/warm', proposalRead, async () => warmRenderer());

  /** Is the renderer installed? The UI uses this to hide PDF options when not. */
  app.get('/render/status', async () => ({ pdf: await pdfAvailable() }));

  /**
   * A vendor's Bill of Materials as a PDF. Same HTML the print dialog uses, so
   * the emailed document and the printed one cannot drift apart.
   */
  app.get('/render/orders/:id/bom.pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { vendor?: string; includeZeroQty?: string };
    const vendor = q.vendor || '*';
    if (!(await pdfAvailable())) {
      throw new ValidationError(
        'PDF rendering is not installed on this deployment — export as Excel instead.',
      );
    }
    const order = await prisma.acceptedOrder.findUnique({
      where: { id },
      select: { number: true },
    });
    if (!order) throw new ValidationError('Order not found');

    const { html, doc } = await renderBomHtml(id, vendor, {
      includeZeroQty: q.includeZeroQty === 'true',
      actorId: req.user!.sub,
    });
    const pdf = await renderPdf(html, { format: 'Letter' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="${bomFilename(order.number, vendor, doc.customer.name)}.pdf"`,
      )
      .send(pdf);
  });

  /**
   * The same document as a real .xlsx workbook. Built from the same model as the
   * PDF, so the two carry identical content — the browser-side CSV this and
   * `/bom.csv` replace had drifted and was missing the addresses, the account and
   * terms, the vendor questions and the notes.
   *
   * Needs no browser, so it lives here beside the PDF only for symmetry of URL.
   */
  app.get('/render/orders/:id/bom.xlsx', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { vendor?: string; includeZeroQty?: string };
    const vendor = q.vendor || '*';
    const order = await prisma.acceptedOrder.findUnique({
      where: { id },
      select: { number: true, organizationId: true },
    });
    if (!order) throw new ValidationError('Order not found');
    const org = await prisma.organization.findUnique({
      where: { id: order.organizationId },
      select: { name: true },
    });
    const { buffer } = await renderBomXlsx(id, vendor, {
      includeZeroQty: q.includeZeroQty === 'true',
      actorId: req.user!.sub,
    });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename="${bomFilename(order.number, vendor, org?.name ?? '')}.xlsx"`,
      )
      .send(buffer);
  });

  /**
   * Bookmarked-URL compatibility: the export used to be a `.xls` file (SpreadsheetML,
   * not a real workbook). Redirected rather than removed outright, for anything that
   * still links to the old path — drop this once nothing does.
   */
  app.get('/render/orders/:id/bom.xls', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { vendor?: string; includeZeroQty?: string };
    const qs = new URLSearchParams();
    if (q.vendor) qs.set('vendor', q.vendor);
    if (q.includeZeroQty) qs.set('includeZeroQty', q.includeZeroQty);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return reply.redirect(`/render/orders/${id}/bom.xlsx${suffix}`, 308);
  });

  /**
   * The same document as a CSV. Built from the same model as the PDF and the
   * xlsx — unlike the browser-built CSV it replaces, it carries the addresses, the
   * vendor questions and the notes alongside the lines.
   */
  app.get('/render/orders/:id/bom.csv', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { vendor?: string; includeZeroQty?: string };
    const vendor = q.vendor || '*';
    const order = await prisma.acceptedOrder.findUnique({
      where: { id },
      select: { number: true, organizationId: true },
    });
    if (!order) throw new ValidationError('Order not found');
    const org = await prisma.organization.findUnique({
      where: { id: order.organizationId },
      select: { name: true },
    });
    const { csv } = await renderBomCsv(id, vendor, {
      includeZeroQty: q.includeZeroQty === 'true',
      actorId: req.user!.sub,
    });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${bomFilename(order.number, vendor, org?.name ?? '')}.csv"`,
      )
      .send(csv);
  });
}

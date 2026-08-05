import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { renderBomHtml, renderBomXml, bomFilename } from '../handoff/bomDocuments.js';
import { uploadProposalPdfToMonday } from '../integrations/monday/proposalPush.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';

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

  /**
   * The released proposal, rendered and dropped into the monday deal row's file
   * column.
   *
   * Split out of the release call deliberately. Release runs on the main API
   * function, which has 30 seconds and no headroom for a cold headless browser —
   * the PDF either never rendered or took the whole request down with it, and the
   * deal board ended up with the numbers but no document. Here it gets the
   * renderer's memory and its 60-second ceiling.
   */
  app.post('/render/proposals/versions/:versionId/monday-file', release, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = (req.body ?? {}) as { proposalHtml?: string; filename?: string };
    if (!body.proposalHtml) throw new ValidationError('The rendered proposal is missing from the request.');
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not available on this deployment.');
    }
    return uploadProposalPdfToMonday({
      versionId,
      proposalHtml: body.proposalHtml,
      filename: body.filename,
    });
  });

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
      throw new ValidationError('PDF rendering is not installed on this deployment — export as Excel instead.');
    }
    const order = await prisma.acceptedOrder.findUnique({ where: { id }, select: { number: true } });
    if (!order) throw new ValidationError('Order not found');

    const { html, doc } = await renderBomHtml(id, vendor, { includeZeroQty: q.includeZeroQty === 'true' });
    const pdf = await renderPdf(html, { format: 'Letter' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${bomFilename(order.number, vendor, doc.customer.name)}.pdf"`)
      .send(pdf);
  });

  /**
   * The same document as a spreadsheet. Built from the same model as the PDF, so
   * the two carry identical content — the browser-side CSV they replace had drifted
   * and was missing the addresses, the account and terms, the vendor questions and
   * the notes.
   *
   * Needs no browser, so it lives here beside the PDF only for symmetry of URL.
   */
  app.get('/render/orders/:id/bom.xls', read, async (req, reply) => {
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
    const xml = await renderBomXml(id, vendor, { includeZeroQty: q.includeZeroQty === 'true' });
    return reply
      .header('Content-Type', 'application/vnd.ms-excel; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${bomFilename(order.number, vendor, org?.name ?? '')}.xls"`)
      .send(xml);
  });

}

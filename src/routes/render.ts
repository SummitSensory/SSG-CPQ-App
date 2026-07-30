import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { renderBomHtml, bomFilename } from '../handoff/bomDocuments.js';
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
}

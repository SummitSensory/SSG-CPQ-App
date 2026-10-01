import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  purchaseOrderSource,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  buildPurchaseOrderModel,
  listOrderPurchaseOrders,
} from '../handoff/purchaseOrder.js';
import {
  renderPurchaseOrderHtml,
  purchaseOrderFilename,
} from '../handoff/purchaseOrderDocument.js';
import { purchaseOrderSendDefaults, sendPurchaseOrder } from '../handoff/purchaseOrderSend.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';

/**
 * Purchase orders to vendors, raised from a locked order's Bill of Materials.
 *
 * Reads on ORDERS_READ and writes on HANDOFF_MANAGE, the same split as the BOM
 * section routes they sit beside.
 */

const PoInputSchema = z.object({
  lineIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  freightMinor: z.number().int().nonnegative().max(100_000_000).nullable(),
  noFreightCharge: z.boolean(),
  notes: z.string().max(4000).nullish(),
});
const CreateSchema = PoInputSchema.extend({ vendor: z.string().trim().min(1).max(160) });
const SendSchema = z.object({
  toName: z.string().trim().max(200).optional(),
  to: z.string().trim().min(1),
  cc: z.string().trim().optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20000),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

export function registerPurchaseOrderRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ORDERS_READ) };
  const write = { preHandler: requirePermission(Permission.HANDOFF_MANAGE) };

  /** Every PO on the order, for the vendor sections. */
  app.get('/orders/:orderId/vendor-pos', read, async (req) => {
    const { orderId } = req.params as { orderId: string };
    return { purchaseOrders: await listOrderPurchaseOrders(orderId) };
  });

  /** What the "Create Purchase Order" window opens with for one vendor. */
  app.get('/orders/:orderId/vendor-pos/source', read, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const { vendor } = req.query as { vendor?: string };
    if (!vendor?.trim()) throw new ValidationError('Which vendor?');
    return purchaseOrderSource(orderId, vendor.trim());
  });

  app.post('/orders/:orderId/vendor-pos', write, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const { vendor, ...input } = parse(CreateSchema, req.body);
    const po = await createPurchaseOrder(
      orderId,
      vendor,
      { ...input, notes: input.notes ?? null },
      req.user!.sub,
    );
    return buildPurchaseOrderModel(po.id);
  });

  app.get('/vendor-pos/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    return buildPurchaseOrderModel(id);
  });

  app.patch('/vendor-pos/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(PoInputSchema, req.body);
    return updatePurchaseOrder(id, { ...input, notes: input.notes ?? null });
  });

  app.delete('/vendor-pos/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    return deletePurchaseOrder(id);
  });

  /** The document itself, for the in-app preview. */
  app.get('/vendor-pos/:id/preview', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { html } = await renderPurchaseOrderHtml(id);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /**
   * The same document as a PDF — what the vendor is emailed. Under /render/* so it
   * runs on the renderer function (see api/render.ts), like the RFQ's.
   */
  app.get('/render/vendor-pos/:id.pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not available on this deployment.');
    }
    const { html, model } = await renderPurchaseOrderHtml(id);
    const pdf = await renderPdf(html, { format: 'Letter' });
    const name = purchaseOrderFilename(model.reference, model.vendor, model.customerName);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${name}.pdf"`)
      .send(pdf);
  });

  app.get('/vendor-pos/:id/send-defaults', read, async (req) => {
    const { id } = req.params as { id: string };
    return purchaseOrderSendDefaults(id);
  });

  /** Email it to the vendor. Under /render/* because it renders the PDF to attach it. */
  app.post('/render/vendor-pos/:id/send', write, async (req) => {
    const { id } = req.params as { id: string };
    return sendPurchaseOrder(id, parse(SendSchema, req.body), req.user!.sub);
  });
}

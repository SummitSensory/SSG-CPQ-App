import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  listRfqVendors, createRfq, setLineIncluded, addRfqLine, removeRfqLine,
  setRfqNotes, startRfqRevision, buildRfqModel, listProposalRfqs,
} from '../handoff/freightRfq.js';
import { renderRfqHtml, rfqFilename } from '../handoff/freightRfqDocument.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';
import { rfqSendDefaults, sendRfq } from '../handoff/freightRfqSend.js';

/**
 * Request for Freight routes.
 *
 * These hang off the PROPOSAL rather than the order: freight is quoted while the
 * proposal is being built, which is the whole point — the number has to be known
 * before the customer sees a price.
 */

const CreateSchema = z.object({ vendor: z.string().trim().min(1).max(160) });
const DraftLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().trim().max(64).optional(),
        name: z.string().max(240).optional(),
        lineType: z.string().max(32).optional(),
        optional: z.boolean().optional(),
        quantity: z.number().optional(),
        costEach: z.number().optional(),
      }),
    )
    .max(500),
});
const NotesSchema = z.object({ notes: z.string().max(4000) });
const LineSchema = z.object({ included: z.boolean() });
const AddLineSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().max(240).optional(),
  quantity: z.number().int().positive().max(9999),
});
const SendSchema = z.object({
  to: z.string().trim().min(1),
  cc: z.string().trim().optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20000),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

export function registerFreightRfqRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /** Vendors on this version, RFQ-capable first. */
  app.get('/proposals/versions/:versionId/rfq/vendors', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return { vendors: await listRfqVendors(versionId) };
  });

  /**
   * The same list, but computed from the lines the builder currently has on
   * screen. Keeps the freight prompt honest while a proposal is being edited,
   * without forcing a save first.
   */
  app.post('/proposals/versions/:versionId/rfq/vendors', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const { lines } = parse(DraftLinesSchema, req.body);
    return { vendors: await listRfqVendors(versionId, lines) };
  });

  app.post('/proposals/versions/:versionId/rfqs', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const { vendor } = parse(CreateSchema, req.body);
    return createRfq({ versionId, vendor }, req.user!.sub);
  });

  /** The panel under Profitability. */
  app.get('/proposals/:proposalId/rfqs', read, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    return { rfqs: await listProposalRfqs(proposalId) };
  });

  app.get('/rfqs/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    return buildRfqModel(id);
  });

  app.patch('/rfqs/:id/notes', write, async (req) => {
    const { id } = req.params as { id: string };
    return setRfqNotes(id, parse(NotesSchema, req.body).notes);
  });

  app.patch('/rfqs/:id/lines/:lineId', write, async (req) => {
    const { id, lineId } = req.params as { id: string; lineId: string };
    return setLineIncluded(id, lineId, parse(LineSchema, req.body).included);
  });

  app.post('/rfqs/:id/lines', write, async (req) => {
    const { id } = req.params as { id: string };
    return addRfqLine(id, parse(AddLineSchema, req.body));
  });

  app.delete('/rfqs/:id/lines/:lineId', write, async (req) => {
    const { id, lineId } = req.params as { id: string; lineId: string };
    return removeRfqLine(id, lineId);
  });

  /** A sent RFQ is frozen; this is how it gets corrected. */
  app.post('/rfqs/:id/revision', write, async (req) => {
    const { id } = req.params as { id: string };
    return startRfqRevision(id, req.user!.sub);
  });

  /** The document itself, for the in-app preview and for printing by hand. */
  app.get('/rfqs/:id/preview', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { html } = await renderRfqHtml(id);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /**
   * The same document as a PDF — byte-for-byte what the vendor is emailed, so
   * what a rep checks before sending is what actually goes out. Served inline:
   * the browser's viewer opens it and the save button is right there.
   */
  app.get('/rfqs/:id/pdf', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await pdfAvailable())) {
      throw new ValidationError('PDF rendering is not available on this deployment.');
    }
    const { html, model } = await renderRfqHtml(id);
    const pdf = await renderPdf(html, { format: 'Letter' });
    const name = rfqFilename(model.reference, model.vendor, model.customerName);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${name}.pdf"`)
      .send(pdf);
  });

  app.get('/rfqs/:id/send-defaults', read, async (req) => {
    const { id } = req.params as { id: string };
    return rfqSendDefaults(id);
  });

  app.post('/rfqs/:id/send', write, async (req) => {
    const { id } = req.params as { id: string };
    return sendRfq(id, parse(SendSchema, req.body), req.user!.sub);
  });
}

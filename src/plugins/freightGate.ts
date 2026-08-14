import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { assertFreightSettled } from '../proposals/freightTrueUpService.js';

/**
 * The freight gate.
 *
 * SSG's whole reason for the freight true-up feature is that a job must be able to
 * move — accepted, invoiced, into production — before the vendors have quoted
 * freight. So the gate is deliberately placed late, at the two points where an
 * unrecovered shipping bill stops being recoverable:
 *
 *   POST /bom/sections/:sectionId/send     — the Bill of Materials going to a vendor
 *   POST /bom/sections/:sectionId/confirm  — that BOM being frozen as sent
 *
 * Accepting the proposal, creating the order and raising the invoice are NOT gated.
 * Blocking those would break the exact workflow this exists to support.
 *
 * Implemented as a request hook rather than as a line inside bomSections.ts because
 * it is a cross-cutting money policy, not part of what a BOM section is: it can be
 * read, audited and lifted in one place, and the BOM module keeps knowing nothing
 * about freight quoting.
 *
 * The gate is satisfied by either answer — the freight figures entered and applied,
 * or an explicit "no freight applies" with a reason. It is never satisfied by
 * silence.
 */

const GATED = /^\/bom\/sections\/([^/?#]+)\/(send|confirm)(?:\?|$)/;

export function registerFreightGate(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST') return;
    const match = GATED.exec(req.url);
    if (!match) return;
    const sectionId = decodeURIComponent(match[1] as string);

    // A missing section is not this hook's problem — the route reports it properly.
    const section = await prisma.bomVendorSection.findUnique({
      where: { id: sectionId },
      select: { orderId: true },
    });
    if (!section) return;
    const order = await prisma.acceptedOrder.findUnique({
      where: { id: section.orderId },
      select: { proposalId: true },
    });
    if (!order) return;

    try {
      await assertFreightSettled(
        order.proposalId,
        'This Bill of Materials cannot go to the vendor yet.',
      );
    } catch (err) {
      // Rethrown so the ordinary error handler formats it; logged so a blocked send
      // is visible in the request log rather than only to the person who tried.
      logger.warn(
        { sectionId, proposalId: order.proposalId, url: req.url },
        'BOM blocked: freight outstanding',
      );
      throw err;
    }
  });
}

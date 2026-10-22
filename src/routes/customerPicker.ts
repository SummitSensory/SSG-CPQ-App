import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { can } from '../authz/rbac.js';
import { env } from '../config/env.js';
import { ValidationError } from '../lib/errors.js';
import { projectIdOfOpportunity } from '../crm/projectId.js';
import { searchCustomers } from '../crm/customerPicker.js';
import { importDealNow } from '../integrations/monday/dealAutoImport.js';

/**
 * The New proposal customer picker (see crm/customerPicker.ts).
 *
 * Searching needs CRM_READ; the monday half of the results is included only for a
 * user who may also bring a customer into the CRM (CRM_WRITE), because offering a
 * row they cannot pick is worse than not offering it. Importing a picked deal needs
 * CRM_WRITE — the same permission as creating an organization by hand. It used to
 * need INTEGRATIONS_MANAGE (the admin import endpoints), which is why the "Find in
 * monday" button answered 403 for every sales rep it was shown to.
 */
export function registerCustomerPickerRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CRM_READ) };
  const write = { preHandler: requirePermission(Permission.CRM_WRITE) };

  app.get('/crm/customer-picker', read, async (req) => {
    const parsed = z.object({ q: z.string().max(120).optional() }).safeParse(req.query ?? {});
    if (!parsed.success) throw new ValidationError('Invalid search');
    const q = (parsed.data.q ?? '').trim();
    return searchCustomers(q, { includeMonday: can(req.user!.role, Permission.CRM_WRITE) });
  });

  app.post('/crm/customer-picker/monday/:itemId', write, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    if (!/^\d{1,20}$/.test(itemId)) throw new ValidationError('Invalid monday item id');
    if (!env.MONDAY_API_TOKEN)
      return reply.status(400).send({
        error: 'MONDAY_TOKEN_MISSING',
        message: 'monday.com is not connected on this deployment.',
      });

    let outcome;
    try {
      outcome = await importDealNow(itemId, 'picker');
    } catch (err) {
      logger.error({ err, itemId }, 'customer picker: monday import failed');
      return reply.status(502).send({
        error: 'MONDAY_IMPORT_FAILED',
        message:
          'monday.com could not be reached to bring this customer in. Try again in a moment.',
      });
    }
    if (outcome.result === 'notfound')
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: 'That deal is no longer on the Deal Tracking board.',
      });
    if (!outcome.opportunityId || !outcome.organizationId)
      return reply.status(422).send({
        error: 'NOT_IMPORTED',
        message: outcome.warnings[0] ?? 'That deal could not be brought into the CRM.',
      });

    const opp = await prisma.opportunity.findUnique({
      where: { id: outcome.opportunityId },
      select: {
        id: true,
        name: true,
        notes: true,
        mondayItemId: true,
        organization: { select: { id: true, name: true } },
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.monday.import',
      details: { itemId, result: outcome.result, opportunityId: outcome.opportunityId },
    });
    return {
      result: outcome.result,
      organizationId: opp?.organization.id ?? outcome.organizationId,
      organizationName: opp?.organization.name ?? '',
      opportunityId: outcome.opportunityId,
      opportunityName: opp?.name ?? null,
      projectId: opp ? projectIdOfOpportunity(opp) : '',
    };
  });
}

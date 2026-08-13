import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import {
  OrganizationInput,
  ContactInput,
  AddressInput,
  RoomInput,
  OpportunityInput,
  AttachmentInput,
} from '../crm/validation.js';
import {
  normalizeOrgName,
  findDuplicateOrganizations,
  findDuplicateContact,
} from '../crm/duplicates.js';
import { ListQuery, buildOrderBy, paginate } from '../crm/query.js';
import { pushOpportunity } from '../integrations/monday/sync.js';
import { randomBytes } from 'node:crypto';

const ORG_SORT = ['name', 'customerType', 'createdAt', 'updatedAt'];
const OPP_SORT = ['name', 'stage', 'fundingStatus', 'createdAt', 'updatedAt'];

export function registerCrmRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CRM_READ) };
  const write = { preHandler: requirePermission(Permission.CRM_WRITE) };

  // ---- Organizations ----
  app.get('/crm/organizations', read, async (req) => {
    const p = ListQuery.parse(req.query);
    const where = p.q ? { OR: [{ name: { contains: p.q, mode: 'insensitive' as const } }] } : {};
    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        orderBy: buildOrderBy(p.sort, p.dir, ORG_SORT, 'createdAt'),
        ...paginate(p.page, p.pageSize),
      }),
      prisma.organization.count({ where }),
    ]);
    return { items, total, page: p.page, pageSize: p.pageSize };
  });

  app.get('/crm/organizations/:id/duplicates', read, async (req) => {
    const { id } = req.params as { id: string };
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundError();
    return findDuplicateOrganizations(org.name, id);
  });

  app.get('/crm/organizations/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const org = await prisma.organization.findUnique({
      where: { id },
      include: { addresses: true, contacts: true },
    });
    if (!org) throw new NotFoundError();
    return org;
  });

  /**
   * Correct a customer's tax standing.
   *
   * There was no way to change an organization after it was created — tax status
   * could only ever be set on the New organization form, and the exemption number had
   * no field at all. So a customer entered as taxable who later produced a
   * certificate (or the reverse) could not be fixed, and the QuickBooks push had
   * nothing right to send.
   *
   * Deliberately narrow: tax standing only. Renaming an organization runs through
   * duplicate detection and normalizedName, and changing a customer type moves it
   * between reporting buckets — neither belongs behind a two-field form.
   *
   * Clearing the exemption flag also clears the number rather than leaving it behind,
   * because a stale certificate number against a taxable customer is worse than none.
   */
  app.patch('/crm/organizations/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        taxExempt: z.boolean(),
        taxExemptId: z.string().trim().max(60).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid tax details.');

    const before = await prisma.organization.findUnique({
      where: { id },
      select: { taxExempt: true, taxExemptId: true },
    });
    if (!before) throw new NotFoundError();

    const taxExempt = parsed.data.taxExempt;
    const taxExemptId = taxExempt ? parsed.data.taxExemptId?.trim() || null : null;

    const org = await prisma.organization.update({
      where: { id },
      data: { taxExempt, taxExemptId },
      select: { id: true, name: true, taxExempt: true, taxExemptId: true },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.org.tax_update',
      details: {
        entity: 'Organization',
        id,
        from: { taxExempt: before.taxExempt, taxExemptId: before.taxExemptId },
        to: { taxExempt, taxExemptId },
      },
    });
    return org;
  });

  app.post('/crm/organizations', write, async (req, reply) => {
    const parsed = OrganizationInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const normalized = normalizeOrgName(parsed.data.name);
    const dupes = await findDuplicateOrganizations(parsed.data.name);
    if (dupes.length && (req.query as { force?: string }).force !== 'true') {
      return reply.status(409).send({
        error: 'DUPLICATE',
        message: 'Possible duplicate organization',
        duplicates: dupes,
      });
    }
    const org = await prisma.organization.create({
      data: { ...parsed.data, normalizedName: normalized },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.org.create',
      details: { entity: 'Organization', id: org.id },
    });
    return reply.status(201).send(org);
  });

  // ---- Contacts ----
  app.post('/crm/contacts', write, async (req, reply) => {
    const parsed = ContactInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const email = parsed.data.email?.toLowerCase();
    const dupes = await findDuplicateContact(parsed.data.organizationId, email);
    if (dupes.length && (req.query as { force?: string }).force !== 'true') {
      return reply
        .status(409)
        .send({ error: 'DUPLICATE', message: 'Contact already exists', duplicates: dupes });
    }
    const contact = await prisma.contact.create({ data: { ...parsed.data, email: email ?? null } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.contact.create',
      details: { id: contact.id },
    });
    return reply.status(201).send(contact);
  });

  // ---- Addresses (billing & shipping) ----
  app.post('/crm/addresses', write, async (req, reply) => {
    const parsed = AddressInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const address = await prisma.address.create({ data: parsed.data });
    return reply.status(201).send(address);
  });

  // ---- Rooms (site survey) ----
  app.post('/crm/rooms', write, async (req, reply) => {
    const parsed = RoomInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const room = await prisma.room.create({ data: parsed.data });
    return reply.status(201).send(room);
  });

  // ---- Opportunities ----
  app.get('/crm/opportunities', read, async (req) => {
    const p = ListQuery.parse(req.query);
    const f = req.query as { stage?: string; fundingStatus?: string; organizationId?: string };
    const where = {
      ...(p.q ? { name: { contains: p.q, mode: 'insensitive' as const } } : {}),
      ...(f.stage ? { stage: f.stage as never } : {}),
      ...(f.fundingStatus ? { fundingStatus: f.fundingStatus as never } : {}),
      ...(f.organizationId ? { organizationId: f.organizationId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        orderBy: buildOrderBy(p.sort, p.dir, OPP_SORT, 'createdAt'),
        ...paginate(p.page, p.pageSize),
      }),
      prisma.opportunity.count({ where }),
    ]);
    // Serialize BigInt budget to string for JSON.
    const items = rows.map((r) => ({
      ...r,
      budgetAmountMinor: r.budgetAmountMinor?.toString() ?? null,
    }));
    return { items, total, page: p.page, pageSize: p.pageSize };
  });

  app.post('/crm/opportunities', write, async (req, reply) => {
    const parsed = OpportunityInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { budgetAmount, budgetCurrency, ...rest } = parsed.data;
    let budgetAmountMinor: bigint | null = null;
    if (budgetAmount) {
      const [whole, frac = ''] = budgetAmount.split('.');
      budgetAmountMinor = BigInt(whole + frac.padEnd(2, '0')); // integer minor units, no float
    }
    const opp = await prisma.opportunity.create({
      data: { ...rest, budgetAmountMinor, budgetCurrency: budgetCurrency ?? null },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.opportunity.create',
      details: { id: opp.id, stage: opp.stage },
    });
    // Outbound two-way sync to monday (no-op if not configured; never blocks the response).
    void pushOpportunity(opp.id);
    return reply
      .status(201)
      .send({ ...opp, budgetAmountMinor: opp.budgetAmountMinor?.toString() ?? null });
  });

  // ---- Attachments: photos / floor plans / measurement docs ----
  // Presigned-upload pattern: server issues a storage key; binary goes to object storage directly.
  app.post('/crm/attachments', write, async (req, reply) => {
    const parsed = AttachmentInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const storageKey = 'uploads/' + randomBytes(16).toString('hex') + '/' + parsed.data.fileName;
    const attachment = await prisma.attachment.create({
      data: {
        category: parsed.data.category,
        fileName: parsed.data.fileName,
        contentType: parsed.data.contentType,
        sizeBytes: parsed.data.sizeBytes,
        organizationId: parsed.data.organizationId ?? null,
        opportunityId: parsed.data.opportunityId ?? null,
        storageKey,
        uploadedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.attachment.create',
      details: { id: attachment.id, category: attachment.category },
    });
    return reply.status(201).send(attachment);
  });
}

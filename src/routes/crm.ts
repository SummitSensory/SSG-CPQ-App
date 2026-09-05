import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import {
  OrganizationInput,
  ContactInput,
  ContactUpdateInput,
  AddressInput,
  RoomInput,
  OpportunityInput,
  AttachmentInput,
} from '../crm/validation.js';
import { pushContactToDeal } from '../integrations/monday/contactPush.js';
import { refreshCustomerIfLinked } from '../integrations/quickbooks/customers.js';
import {
  normalizeOrgName,
  findDuplicateOrganizations,
  findDuplicateContact,
} from '../crm/duplicates.js';
import { ListQuery, buildOrderBy, paginate } from '../crm/query.js';
import { projectIdOfOpportunity } from '../crm/projectId.js';
import { pushOpportunity } from '../integrations/monday/sync.js';
import { fetchItemById } from '../integrations/monday/discovery.js';
import { DEAL_COL, buildAddress } from '../integrations/monday/crmMapping.js';
import { isMondayPushConfigured } from '../config/env.js';
import { normalizeCountry, normalizeProvince, isCanada } from '../lib/country.js';
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

  /**
   * Correct a contact — most importantly, the email QuickBooks invoices go to.
   * `loadCustomerSource` (quickbooks/customers.ts) picks the org's contact by
   * isDecisionMaker first, so promoting one here demotes every other contact on
   * the same organization; there is exactly one "the" invoice contact at a time.
   *
   * Pushes the correction on to monday and QuickBooks so both stay in step with
   * the CRM instead of drifting until someone notices at billing time — the
   * reason this endpoint exists at all (see `customerProfile.ts`'s "Invoice
   * email" comparison). Both pushes are best effort and fire-and-forget: a
   * contact edit must save locally even when an external system can't be
   * reached, and each push logs its own failure.
   */
  app.patch('/crm/contacts/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ContactUpdateInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Contact not found');

    if (parsed.data.email) {
      const dupes = await findDuplicateContact(existing.organizationId, parsed.data.email, id);
      if (dupes.length && (req.query as { force?: string }).force !== 'true') {
        return reply
          .status(409)
          .send({ error: 'DUPLICATE', message: 'Contact already exists', duplicates: dupes });
      }
    }

    if (parsed.data.isDecisionMaker === true) {
      await prisma.contact.updateMany({
        where: { organizationId: existing.organizationId, id: { not: id } },
        data: { isDecisionMaker: false },
      });
    }

    const contact = await prisma.contact.update({ where: { id }, data: parsed.data });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.contact.update',
      details: { id: contact.id },
    });

    // monday is fire-and-forget — nothing in this response reflects its state back
    // to whoever is saving. QuickBooks is awaited (but still never fails the save)
    // because the caller is typically the customer-profile comparison panel, which
    // re-reads QuickBooks right after saving; awaiting means that re-read sees the
    // correction instead of racing it.
    void pushContactToDeal(existing.organizationId, contact).catch((err) =>
      logger.error({ err, contactId: contact.id }, 'monday: contact push failed'),
    );
    try {
      await refreshCustomerIfLinked(existing.organizationId, req.user!.sub);
    } catch (err) {
      logger.error(
        { err, organizationId: existing.organizationId },
        'quickbooks: contact-driven customer refresh failed',
      );
    }

    return contact;
  });

  // ---- Addresses (billing & shipping) ----
  app.post('/crm/addresses', write, async (req, reply) => {
    const parsed = AddressInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const address = await prisma.address.create({ data: parsed.data });
    return reply.status(201).send(address);
  });

  /* ---- The billing address ----
   *
   * Its own endpoints, and the only ones that WRITE an organization's address,
   * because one field on it decides how a whole proposal is priced:
   * resolveJurisdiction() reads the BILLING address country, and a Canadian
   * customer sitting at the imported default of "US" is quoted as a domestic job
   * with no tax, no duty and no CAD column.
   *
   * Until now there was no way to correct one. The CRM import writes an address
   * only when the organization has NONE (writeAddressIfMissing), so a customer
   * imported before their country was filled in on the deal row could never be
   * fixed, from anywhere.
   *
   * Upsert rather than create: an organization has one billing address, and a
   * second one would leave resolveJurisdiction() picking between them.
   */

  const BillingAddressInput = z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(1).max(120),
    /** State or province. Normalized to a two-letter code for Canada. */
    region: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().min(1).max(20),
    /** Anything normalizeCountry accepts: CA, CAN, Canada, US, USA, United States. */
    country: z.string().trim().min(2).max(60),
  });

  /**
   * Normalize what a person typed into what the engine reads.
   *
   * The country becomes ISO alpha-2 or the request is refused — a country this
   * application does not recognize would resolve to no jurisdiction at all, which
   * reads downstream as "not Canadian" and is exactly the silent mistake these
   * endpoints exist to prevent. The province is normalized only for Canada; US
   * states are stored as typed, as the import already does.
   */
  function normalizeBilling(input: z.infer<typeof BillingAddressInput>) {
    const country = normalizeCountry(input.country);
    if (!country) {
      throw new ValidationError(
        `"${input.country}" was not recognized as a country. Enter Canada or United States.`,
      );
    }
    let region = input.region;
    if (isCanada(country)) {
      const province = normalizeProvince(input.region);
      if (!province) {
        throw new ValidationError(
          `"${input.region}" was not recognized as a Canadian province or territory.`,
        );
      }
      region = province;
    }
    return {
      line1: input.line1,
      line2: input.line2?.trim() || null,
      city: input.city,
      region,
      postalCode: input.postalCode,
      country,
    };
  }

  async function writeBilling(
    organizationId: string,
    data: ReturnType<typeof normalizeBilling>,
    actorId: string,
    source: 'typed' | 'monday',
  ) {
    const existing = await prisma.address.findFirst({
      where: { organizationId, type: 'BILLING' },
      select: { id: true, line1: true, city: true, region: true, postalCode: true, country: true },
    });
    const address = existing
      ? await prisma.address.update({ where: { id: existing.id }, data })
      : await prisma.address.create({ data: { ...data, organizationId, type: 'BILLING' } });

    await recordAudit({
      actorId,
      action: 'crm.org.billing_address',
      details: {
        entity: 'Address',
        id: address.id,
        organizationId,
        source,
        from: existing ?? null,
        to: {
          line1: data.line1,
          city: data.city,
          region: data.region,
          postalCode: data.postalCode,
          country: data.country,
        },
      },
    });
    return address;
  }

  app.put('/crm/organizations/:id/billing-address', write, async (req) => {
    const { id } = req.params as { id: string };
    const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
    if (!org) throw new NotFoundError();
    const parsed = BillingAddressInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid address.');
    return writeBilling(id, normalizeBilling(parsed.data), req.user!.sub, 'typed');
  });

  /**
   * Re-read the address off the monday deal row, overwriting what is here.
   *
   * The bulk-correction path: fix the Country column on the board and pull it,
   * rather than retyping an address that is already correct somewhere else. It
   * overwrites deliberately — the import's skip-if-present rule is what left these
   * addresses stale, and a pull that also skipped would be a button that does
   * nothing on every row that needs it.
   *
   * The deal row is found through the organization's linked opportunity, which is
   * where the CRM import records the monday item id.
   */
  app.post('/crm/organizations/:id/billing-address/from-monday', write, async (req) => {
    const { id } = req.params as { id: string };
    if (!isMondayPushConfigured()) {
      throw new ValidationError(
        'monday.com is not configured on this deployment, so there is no deal row to read.',
      );
    }
    const opp = await prisma.opportunity.findFirst({
      where: { organizationId: id, mondayItemId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { mondayItemId: true },
    });
    if (!opp?.mondayItemId) {
      throw new ValidationError(
        'This customer is not linked to a monday deal row, so there is nothing to pull. Enter the address by hand.',
      );
    }
    const item = await fetchItemById(opp.mondayItemId);
    if (!item) {
      throw new NotFoundError(
        `monday item ${opp.mondayItemId} is not visible to this token. Check the board sharing.`,
      );
    }
    const addr = buildAddress(item.text, item.raw[DEAL_COL.location]);
    if (!addr) {
      throw new ValidationError(
        'The deal row has no address columns filled in. Fill in the street, city, state/province, postal code and Country on the board, then pull again.',
      );
    }
    // Every split address column on the board is optional, so each one can come back
    // null. Named individually in the message rather than reported as "incomplete":
    // whoever reads this has to go and fill in a specific column.
    const labels: Array<[string, string | null]> = [
      ['street address', addr.line1],
      ['city', addr.city],
      ['state or province', addr.region],
      ['postal code', addr.postalCode],
    ];
    const blank = labels.filter(([, v]) => !String(v ?? '').trim()).map(([label]) => label);
    if (blank.length) {
      throw new ValidationError(
        `The monday deal row has no ${blank.join(', ')}. Fill those columns in on the board, then pull again.`,
      );
    }

    const data = normalizeBilling({
      line1: String(addr.line1),
      line2: addr.line2 ? String(addr.line2) : null,
      city: String(addr.city),
      region: String(addr.region),
      postalCode: String(addr.postalCode),
      country: String(addr.country || 'US'),
    });
    const address = await writeBilling(id, data, req.user!.sub, 'monday');
    return { address, mondayItemId: opp.mondayItemId };
  });

  // ---- Rooms (site survey) ----
  app.post('/crm/rooms', write, async (req, reply) => {
    const parsed = RoomInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const room = await prisma.room.create({ data: parsed.data });
    return reply.status(201).send(room);
  });

  // ---- Opportunities ----
  /**
   * `q` matches the opportunity's own name, its customer's name, and its Project ID
   * — the three things a rep might type when hunting for a specific project rather
   * than a specific customer. `organizationName`, `projectId` and `closed` are
   * computed onto each row for the same reason: the New Proposal picker lists one
   * row per project (see public/app.js), and needs all three to label one.
   */
  app.get('/crm/opportunities', read, async (req) => {
    const p = ListQuery.parse(req.query);
    const f = req.query as { stage?: string; fundingStatus?: string; organizationId?: string };
    const where = {
      ...(p.q
        ? {
            OR: [
              { name: { contains: p.q, mode: 'insensitive' as const } },
              { notes: { contains: p.q, mode: 'insensitive' as const } },
              { organization: { name: { contains: p.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
      ...(f.stage ? { stage: f.stage as never } : {}),
      ...(f.fundingStatus ? { fundingStatus: f.fundingStatus as never } : {}),
      ...(f.organizationId ? { organizationId: f.organizationId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        include: { organization: { select: { name: true } } },
        orderBy: buildOrderBy(p.sort, p.dir, OPP_SORT, 'createdAt'),
        ...paginate(p.page, p.pageSize),
      }),
      prisma.opportunity.count({ where }),
    ]);
    // Serialize BigInt budget to string for JSON.
    const items = rows.map((r) => {
      const { organization, ...rest } = r;
      return {
        ...rest,
        budgetAmountMinor: r.budgetAmountMinor?.toString() ?? null,
        organizationName: organization.name,
        projectId: projectIdOfOpportunity(r),
        closed: r.stage === 'CLOSED_WON' || r.stage === 'CLOSED_LOST',
      };
    });
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

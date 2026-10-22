import type { CustomerType, OpportunityStage } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { normalizeCountry } from '../../lib/country.js';
import { fetchItemById, type MondayItem } from './discovery.js';
import {
  DEAL_COL,
  buildAddress,
  clean,
  firstLabel,
  isUnmappedIndustry,
  parseEmail,
  parseMoneyMinor,
  splitName,
  toCustomerType,
  toStage,
} from './crmMapping.js';

/**
 * "Pull from monday" on a CRM customer or project: re-read the Deal Tracking row and
 * bring across what was entered there after the customer reached the CRM — a contact
 * added later, a phone number, the site address, the deal's value.
 *
 * Two steps, like the freight pull's rule that a pull never clobbers a manual
 * correction: `customerPullPlan` reads the row and lists every difference, and
 * `applyCustomerPull` writes only the ones the person ticked. A blank in the CRM
 * that monday can fill is offered ticked (FILL); a value the CRM already holds that
 * monday says differently is offered unticked (DIFFERS) — somebody may have fixed it
 * here on purpose. The plan is re-read from monday on apply, so what is written is
 * what monday says at that moment, never a stale preview.
 *
 * Inbound only, like the rest of the CRM import (crmImport.ts): nothing is written to
 * monday, and nothing here touches QuickBooks.
 */

export type PullChangeKind = 'FILL' | 'DIFFERS';

export interface PullChange {
  key: string;
  label: string;
  current: string | null;
  incoming: string;
  kind: PullChangeKind;
}

export interface CustomerPullPlan {
  itemId: string;
  dealName: string;
  organizationId: string;
  opportunityId: string | null;
  changes: PullChange[];
}

export class CustomerPullError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'CustomerPullError';
  }
}

interface IncomingDeal {
  contact: {
    first: string;
    last: string;
    email: string | null;
    phone: string | null;
    title: string | null;
  } | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string;
  } | null;
  customerType: CustomerType | null;
  stage: OpportunityStage;
  budgetMinor: bigint | null;
}

function readDeal(item: MondayItem): IncomingDeal {
  const fullName = clean(item.text[DEAL_COL.contactName]);
  const email = parseEmail(item.raw[DEAL_COL.contactEmail], item.text[DEAL_COL.contactEmail] ?? '');
  const name = fullName || email ? splitName(fullName ?? email ?? '', '') : null;
  const addr = buildAddress(item.text, item.raw[DEAL_COL.location]);
  const industry = firstLabel(item.text[DEAL_COL.industry]);
  return {
    contact: name
      ? {
          first: name.first,
          last: name.last,
          email,
          phone: clean(item.text[DEAL_COL.contactPhone]),
          title: clean(item.text[DEAL_COL.contactTitle]),
        }
      : null,
    address: addr
      ? {
          line1: addr.line1,
          line2: addr.line2,
          city: addr.city,
          region: addr.region,
          postalCode: addr.postalCode,
          country: normalizeCountry(addr.country ?? '') ?? addr.country ?? 'US',
        }
      : null,
    // An industry the mapping does not know falls back to OTHER — not worth offering
    // over whatever type a person chose here.
    customerType: industry && !isUnmappedIndustry(industry) ? toCustomerType(industry) : null,
    stage: toStage(item.text[DEAL_COL.stage]),
    budgetMinor:
      parseMoneyMinor(item.text[DEAL_COL.grandTotal]) ?? parseMoneyMinor(item.text[DEAL_COL.value]),
  };
}

const norm = (v: string | null | undefined) => (v ?? '').trim();
const same = (a: string | null | undefined, b: string | null | undefined) =>
  norm(a).toLowerCase() === norm(b).toLowerCase();

function formatAddress(a: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string {
  return [
    [a.line1, a.line2].filter((s) => norm(s)).join(', '),
    [a.city, [a.region, a.postalCode].filter((s) => norm(s)).join(' ')]
      .filter((s) => norm(s))
      .join(', '),
    norm(a.country),
  ]
    .filter((s) => norm(s))
    .join(', ');
}

const dollars = (minor: bigint) =>
  '$' + (Number(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

/** The deal row behind a customer: the named project, else its most recently touched one. */
async function dealFor(organizationId: string, opportunityId?: string | null) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, customerType: true },
  });
  if (!org) throw new CustomerPullError('Customer not found.', 404);
  const opp = await prisma.opportunity.findFirst({
    where: opportunityId
      ? { id: opportunityId, organizationId }
      : { organizationId, mondayItemId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, mondayItemId: true, stage: true, budgetAmountMinor: true },
  });
  if (opportunityId && !opp)
    throw new CustomerPullError('Project not found for this customer.', 404);
  if (!opp?.mondayItemId) {
    throw new CustomerPullError(
      'This customer is not linked to a monday Deal Tracking row, so there is nothing to pull.',
    );
  }
  const item = await fetchItemById(opp.mondayItemId);
  if (!item) {
    throw new CustomerPullError(
      `monday item ${opp.mondayItemId} could not be read — it may have been deleted, or the board is not shared with this token.`,
      404,
    );
  }
  return { org, opp, item };
}

/** The contact the deal's primary contact corresponds to: same email, else same name. */
async function matchContact(
  organizationId: string,
  incoming: NonNullable<IncomingDeal['contact']>,
) {
  if (incoming.email) {
    const byEmail = await prisma.contact.findFirst({
      where: { organizationId, email: { equals: incoming.email, mode: 'insensitive' } },
    });
    if (byEmail) return byEmail;
  }
  return prisma.contact.findFirst({
    where: {
      organizationId,
      firstName: { equals: incoming.first, mode: 'insensitive' },
      lastName: { equals: incoming.last, mode: 'insensitive' },
    },
  });
}

async function shippingAddressOf(organizationId: string) {
  return (
    (await prisma.address.findFirst({ where: { organizationId, type: 'SHIPPING' } })) ??
    (await prisma.address.findFirst({ where: { organizationId } }))
  );
}

function change(
  key: string,
  label: string,
  current: string | null | undefined,
  incoming: string | null | undefined,
): PullChange | null {
  if (!norm(incoming)) return null;
  if (same(current, incoming)) return null;
  return {
    key,
    label,
    current: norm(current) || null,
    incoming: norm(incoming),
    kind: norm(current) ? 'DIFFERS' : 'FILL',
  };
}

export async function customerPullPlan(
  organizationId: string,
  opportunityId?: string | null,
): Promise<CustomerPullPlan> {
  const { org, opp, item } = await dealFor(organizationId, opportunityId);
  const deal = readDeal(item);
  const changes: PullChange[] = [];
  const push = (c: PullChange | null) => {
    if (c) changes.push(c);
  };

  if (deal.contact) {
    const existing = await matchContact(organizationId, deal.contact);
    const fullName = `${deal.contact.first} ${deal.contact.last}`.trim();
    if (!existing) {
      push({
        key: 'contact.new',
        label: 'Primary contact (new)',
        current: null,
        incoming: [fullName, deal.contact.title, deal.contact.email, deal.contact.phone]
          .filter((s) => norm(s))
          .join(' · '),
        kind: 'FILL',
      });
    } else {
      push(
        change(
          'contact.name',
          'Contact name',
          `${existing.firstName} ${existing.lastName}`.trim(),
          fullName,
        ),
      );
      push(change('contact.email', 'Contact email', existing.email, deal.contact.email));
      push(change('contact.phone', 'Contact phone', existing.phone, deal.contact.phone));
      push(change('contact.title', 'Contact title', existing.title, deal.contact.title));
    }
  }

  if (deal.address) {
    const current = await shippingAddressOf(organizationId);
    const a = deal.address;
    // Compared field by field, and only on what the deal actually fills in: a row with
    // no street still saves a line1 (the city stands in — the import's rule too), and
    // that must not read as a difference on every pull afterwards.
    const matches =
      !!current &&
      (!a.line1 || same(current.line1, a.line1)) &&
      (!a.line2 || same(current.line2, a.line2)) &&
      (!a.city || same(current.city, a.city)) &&
      (!a.region || same(current.region, a.region)) &&
      (!a.postalCode || same(current.postalCode, a.postalCode)) &&
      same(normalizeCountry(current.country) ?? current.country, a.country);
    if (!matches) {
      push({
        key: 'address',
        label: 'Site / shipping address',
        current: current ? formatAddress(current) || null : null,
        incoming: formatAddress(a),
        kind: current && formatAddress(current) ? 'DIFFERS' : 'FILL',
      });
    }
  }

  if (deal.customerType) {
    push(change('org.customerType', 'Customer type', org.customerType, deal.customerType));
  }
  push(change('opp.stage', 'Project stage', opp.stage, deal.stage));
  if (deal.budgetMinor != null) {
    push(
      change(
        'opp.budget',
        'Project value',
        opp.budgetAmountMinor != null ? dollars(opp.budgetAmountMinor) : null,
        dollars(deal.budgetMinor),
      ),
    );
  }

  return {
    itemId: item.id,
    dealName: item.name,
    organizationId,
    opportunityId: opp.id,
    changes,
  };
}

/**
 * Write the ticked changes. The plan is read afresh from monday first; a key that no
 * longer appears in it (monday was corrected in between, or it already matches) is
 * skipped rather than written from a stale preview.
 */
export async function applyCustomerPull(
  organizationId: string,
  opportunityId: string | null | undefined,
  keys: string[],
): Promise<{ plan: CustomerPullPlan; applied: string[] }> {
  const plan = await customerPullPlan(organizationId, opportunityId);
  const wanted = new Set(keys);
  const applied = plan.changes.filter((c) => wanted.has(c.key)).map((c) => c.key);
  if (!applied.length) return { plan, applied };

  const { org, opp, item } = await dealFor(organizationId, plan.opportunityId);
  const deal = readDeal(item);
  const has = (k: string) => applied.includes(k);

  await prisma.$transaction(async (tx) => {
    if (deal.contact) {
      const c = deal.contact;
      if (has('contact.new')) {
        await tx.contact.create({
          data: {
            organizationId,
            firstName: c.first,
            lastName: c.last,
            email: c.email,
            phone: c.phone,
            title: c.title,
            // The deal's contact is its primary one, as the import treats it.
            isDecisionMaker: true,
          },
        });
      } else {
        const existing = await matchContact(organizationId, c);
        if (existing) {
          await tx.contact.update({
            where: { id: existing.id },
            data: {
              ...(has('contact.name') ? { firstName: c.first, lastName: c.last } : {}),
              ...(has('contact.email') ? { email: c.email } : {}),
              ...(has('contact.phone') ? { phone: c.phone } : {}),
              ...(has('contact.title') ? { title: c.title } : {}),
            },
          });
        }
      }
    }

    if (has('address') && deal.address) {
      const a = deal.address;
      const data = {
        line1: a.line1 ?? a.city ?? org.name,
        line2: a.line2,
        city: a.city ?? '',
        region: a.region ?? '',
        postalCode: a.postalCode ?? '',
        country: a.country,
      };
      const current = await shippingAddressOf(organizationId);
      if (current) await tx.address.update({ where: { id: current.id }, data });
      else await tx.address.create({ data: { ...data, organizationId, type: 'SHIPPING' } });
    }

    if (has('org.customerType') && deal.customerType) {
      await tx.organization.update({
        where: { id: org.id },
        data: { customerType: deal.customerType },
      });
    }

    if (has('opp.stage') || has('opp.budget')) {
      await tx.opportunity.update({
        where: { id: opp.id },
        data: {
          ...(has('opp.stage') ? { stage: deal.stage } : {}),
          ...(has('opp.budget') && deal.budgetMinor != null
            ? { budgetAmountMinor: deal.budgetMinor, budgetCurrency: 'USD' }
            : {}),
          mondaySyncedAt: new Date(),
        },
      });
    }
  });

  return { plan, applied };
}

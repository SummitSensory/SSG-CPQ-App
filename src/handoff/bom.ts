import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';

/**
 * The Bill of Materials.
 *
 * One document per vendor (or one combined document across all of them), built
 * from the order's procurement lines. It is a manufacturing/purchasing document,
 * not a customer document: quantities, powder colour, weight and OUR unit cost,
 * addressed like a purchase order — Summit ships from the vendor, ships to
 * either the customer's site or Summit's dock.
 *
 * Everything here is read-only assembly. The numbers come from the line
 * snapshots taken at lock time, so re-printing a BOM months later gives the same
 * document.
 */

/** Summit Sensory Gym, as it prints on every report. */
export const COMPANY = {
  name: 'Summit Sensory Gym',
  addressLine1: '6150 S Geneva Court',
  city: 'Englewood',
  region: 'CO',
  postalCode: '80111',
  phone: '720-440-7850',
  email: 'Orders@SummitSensory.com',
} as const;

export interface BomLine {
  id: string;
  lineNo: string;
  sku: string;
  name: string;
  quantity: number;
  powderColor: string;
  unitCostMinor: number;
  extendedCostMinor: number;
  unitWeightLbs: number;
  extendedWeightLbs: number;
  vendor: string;
  vendorNotes: string;
  sourced: boolean;
  isSteel: boolean;
}

export interface BomDocument {
  order: {
    id: string; number: string; status: string; acceptedVersion: number;
    jobName: string; shipTo: 'CUSTOMER' | 'SUMMIT';
    submittedOn: string | null; deliveryType: string; powderCoatBrand: string;
    shipmentQuote: string; notes: string;
  };
  company: typeof COMPANY;
  createdBy: { name: string; email: string; title: string } | null;
  createdAt: string;
  customer: {
    name: string; contactName: string; contactTitle: string; contactEmail: string; contactPhone: string;
    addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; country: string;
  };
  shipTo: { label: string; name: string; lines: string[]; contactName: string; phone: string; email: string };
  vendors: string[];
  vendor: {
    name: string; contactName: string; contactTitle: string; contactEmail: string; contactPhone: string;
    addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; country: string;
    accountNumber: string; paymentTerms: string; leadTimeDays: number | null; isSteelFabricator: boolean;
  } | null;
  lines: BomLine[];
  totals: {
    lineCount: number; unitCount: number; extendedCostMinor: number;
    steelWeightLbs: number; totalWeightLbs: number;
  };
}

const s = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Build one BOM. `vendor` is a vendor name, or '*' for every vendor combined.
 * `includeZeroQty` adds the rest of that vendor's catalogue at qty 0 — the
 * "full order form" style, so the shop can hand-add a part without a new sheet.
 */
export async function buildBom(
  orderId: string,
  opts: { vendor?: string; includeZeroQty?: boolean } = {},
): Promise<BomDocument> {
  const vendorFilter = opts.vendor && opts.vendor !== '*' ? opts.vendor : null;

  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    include: { procurement: true, customerApproval: true },
  });
  if (!order) throw new NotFoundError('Order not found');

  const [org, creator, manufacturers, proposal] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: order.organizationId },
      include: {
        addresses: true,
        contacts: { orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }], take: 5 },
      },
    }),
    prisma.user.findUnique({ where: { id: order.acceptedById }, select: { name: true, email: true, title: true } }),
    prisma.manufacturer.findMany(),
    prisma.proposal.findUnique({ where: { id: order.proposalId }, select: { title: true } }),
  ]);

  const mfrByName = new Map(manufacturers.map((m) => [m.name.toLowerCase(), m]));
  const steelVendors = new Set(manufacturers.filter((m) => m.isSteelFabricator).map((m) => m.name.toLowerCase()));

  // ---- lines ----
  const ordered = [...order.procurement].sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
  const scoped = vendorFilter
    ? ordered.filter((l) => (s(l.vendor).trim() || 'Unassigned vendor') === vendorFilter)
    : ordered;

  const lines: BomLine[] = scoped.map((l) => {
    const qty = Number(l.quantity) || 0;
    const cost = l.unitCostMinor ?? 0;
    const wt = l.unitWeightLbs == null ? 0 : Number(l.unitWeightLbs);
    const vendorName = s(l.vendor).trim() || 'Unassigned vendor';
    return {
      id: l.id,
      lineNo: s(l.sku) || '—',
      sku: s(l.sku),
      name: l.name,
      quantity: qty,
      powderColor: s(l.powderColor),
      unitCostMinor: cost,
      extendedCostMinor: cost * qty,
      unitWeightLbs: wt,
      extendedWeightLbs: Math.round(wt * qty * 1000) / 1000,
      vendor: vendorName,
      vendorNotes: s(l.vendorNotes),
      sourced: l.sourced,
      isSteel: steelVendors.has(vendorName.toLowerCase()),
    };
  });

  // ---- optional zero-quantity rows: the rest of this vendor's catalogue ----
  if (opts.includeZeroQty && vendorFilter && vendorFilter !== 'Unassigned vendor') {
    const have = new Set(lines.map((l) => l.sku).filter(Boolean));
    const mfr = mfrByName.get(vendorFilter.toLowerCase());
    const [skus, sourced] = await Promise.all([
      prisma.sku.findMany({ where: { manufacturer: vendorFilter, active: true }, select: { part: true, description: true, unitCostMinor: true, weightLbs: true } }),
      mfr
        ? prisma.productSourcing.findMany({ where: { manufacturerId: mfr.id }, select: { product: { select: { sku: true, name: true, status: true } } } })
        : Promise.resolve([] as Array<{ product: { sku: string; name: string; status: string } }>),
    ]);
    const extra = new Map<string, { sku: string; name: string; unitCostMinor: number; weightLbs: number }>();
    for (const k of skus) {
      if (!have.has(k.part)) extra.set(k.part, { sku: k.part, name: k.description, unitCostMinor: k.unitCostMinor, weightLbs: Number(k.weightLbs) });
    }
    for (const r of sourced) {
      if (!have.has(r.product.sku) && !extra.has(r.product.sku) && r.product.status === 'ACTIVE') {
        extra.set(r.product.sku, { sku: r.product.sku, name: r.product.name, unitCostMinor: 0, weightLbs: 0 });
      }
    }
    for (const e of [...extra.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
      lines.push({
        id: `zero:${e.sku}`, lineNo: e.sku, sku: e.sku, name: e.name, quantity: 0, powderColor: '',
        unitCostMinor: e.unitCostMinor, extendedCostMinor: 0, unitWeightLbs: e.weightLbs, extendedWeightLbs: 0,
        vendor: vendorFilter, vendorNotes: '', sourced: false,
        isSteel: steelVendors.has(vendorFilter.toLowerCase()),
      });
    }
  }

  // ---- customer block ----
  const ship = org?.addresses.find((a) => a.type === 'SHIPPING') ?? org?.addresses[0] ?? null;
  const contact = org?.contacts[0] ?? null;
  const customer = {
    name: org?.name ?? '',
    contactName: contact ? `${contact.firstName} ${contact.lastName}`.trim() : s(order.customerApproval?.approverName),
    contactTitle: s(contact?.title ?? order.customerApproval?.approverTitle),
    contactEmail: s(contact?.email ?? order.customerApproval?.approverEmail),
    contactPhone: s(contact?.phone),
    addressLine1: s(ship?.line1),
    addressLine2: s(ship?.line2),
    city: s(ship?.city),
    region: s(ship?.region),
    postalCode: s(ship?.postalCode),
    country: s(ship?.country ?? 'USA'),
  };

  // ---- ship-to block: the customer's site, or Summit's dock ----
  const cityLine = (city: string, region: string, zip: string) => [city, [region, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const shipTo = order.bomShipTo === 'SUMMIT'
    ? {
      label: 'Summit Sensory Gym',
      name: COMPANY.name,
      lines: [COMPANY.addressLine1, cityLine(COMPANY.city, COMPANY.region, COMPANY.postalCode)].filter(Boolean),
      contactName: creator?.name ?? '',
      phone: COMPANY.phone,
      email: COMPANY.email,
    }
    : {
      label: 'Customer site',
      name: customer.name,
      lines: [customer.addressLine1, customer.addressLine2, cityLine(customer.city, customer.region, customer.postalCode)].filter(Boolean),
      contactName: customer.contactName,
      phone: customer.contactPhone,
      email: customer.contactEmail,
    };

  // ---- vendor block (only for a single-vendor BOM) ----
  const mfr = vendorFilter ? mfrByName.get(vendorFilter.toLowerCase()) : undefined;
  const vendor = vendorFilter
    ? {
      name: vendorFilter,
      contactName: s(mfr?.contactName),
      contactTitle: s(mfr?.contactTitle),
      contactEmail: s(mfr?.contactEmail),
      contactPhone: s(mfr?.contactPhone),
      addressLine1: s(mfr?.addressLine1),
      addressLine2: s(mfr?.addressLine2),
      city: s(mfr?.city),
      region: s(mfr?.region),
      postalCode: s(mfr?.postalCode),
      country: s(mfr?.country),
      accountNumber: s(mfr?.accountNumber),
      paymentTerms: s(mfr?.paymentTerms),
      leadTimeDays: mfr?.defaultLeadTimeDays ?? null,
      isSteelFabricator: !!mfr?.isSteelFabricator,
    }
    : null;

  // ---- totals ----
  // Steel weight excludes hardware and crating by construction: only vendors
  // flagged as steel fabricators contribute to it.
  const totals = {
    lineCount: lines.filter((l) => l.quantity > 0).length,
    unitCount: lines.reduce((a, l) => a + l.quantity, 0),
    extendedCostMinor: lines.reduce((a, l) => a + l.extendedCostMinor, 0),
    steelWeightLbs: Math.round(lines.filter((l) => l.isSteel).reduce((a, l) => a + l.extendedWeightLbs, 0) * 100) / 100,
    totalWeightLbs: Math.round(lines.reduce((a, l) => a + l.extendedWeightLbs, 0) * 100) / 100,
  };

  const vendors = [...new Set(ordered.map((l) => s(l.vendor).trim() || 'Unassigned vendor'))]
    .sort((a, b) => (a === 'Unassigned vendor' ? 1 : b === 'Unassigned vendor' ? -1 : a.localeCompare(b)));

  return {
    order: {
      id: order.id, number: order.number, status: order.status, acceptedVersion: order.acceptedVersion,
      jobName: s(order.jobName) || s(proposal?.title) || s(org?.name),
      shipTo: order.bomShipTo,
      submittedOn: order.bomSubmittedOn ? order.bomSubmittedOn.toISOString() : null,
      deliveryType: s(order.deliveryType),
      powderCoatBrand: s(order.powderCoatBrand),
      shipmentQuote: s(order.shipmentQuote),
      notes: s(order.bomNotes),
    },
    company: COMPANY,
    createdBy: creator ? { name: s(creator.name), email: s(creator.email), title: s(creator.title) } : null,
    createdAt: new Date().toISOString(),
    customer,
    shipTo,
    vendors,
    vendor,
    lines,
    totals,
  };
}

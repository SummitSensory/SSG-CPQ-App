import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { vendorPartLookup } from './vendorParts.js';
import { defaultJobName } from './bomSections.js';
import { isRollupHardwarePart, rollUpBomLines } from './bomRollup.js';

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
  phone: '720-457-5500',
  email: 'Orders@SummitSensory.com',
} as const;

export interface BomLine {
  id: string;
  /**
   * What prints in the Line # column. The vendor's own number where we and the
   * vendor number a part differently (the Adventure mats), otherwise our SKU — the
   * BOM is a purchasing document, so the vendor has to be able to order from it.
   */
  lineNo: string;
  /** Our internal part number, always. Kept alongside lineNo for traceability. */
  sku: string;
  /** The vendor's number where it differs from ours, else ''. */
  vendorSku: string;
  name: string;
  quantity: number;
  powderColor: string;
  /** Packaging bag the part ships in, e.g. "Bag 7". Blank when it is not bagged. */
  packagingBag: string;
  unitCostMinor: number;
  extendedCostMinor: number;
  unitWeightLbs: number;
  extendedWeightLbs: number;
  vendor: string;
  vendorNotes: string;
  sourced: boolean;
  isSteel: boolean;
  /** Product-tree sort order. Hardware carries Infinity so it sorts last. */
  treeOrder: number;
  isHardware: boolean;
  /**
   * Summit bought this part elsewhere and had it shipped to this vendor, who is
   * crating it. It prints with no cost and adds nothing to the sheet's total — we
   * have already paid for it and are not asking this vendor to buy it.
   */
  freeIssue: boolean;
  /** Who it was actually bought from, printed as the free-issue note's source. */
  purchaseVendor: string;
}

export interface BomDocument {
  order: {
    id: string;
    number: string;
    status: string;
    acceptedVersion: number;
    jobName: string;
    shipTo: 'CUSTOMER' | 'SUMMIT';
    submittedOn: string | null;
    deliveryType: string;
    powderCoatBrand: string;
    shipmentQuote: string;
    notes: string;
  };
  company: typeof COMPANY;
  createdBy: { name: string; email: string; title: string } | null;
  createdAt: string;
  customer: {
    name: string;
    contactName: string;
    contactTitle: string;
    contactEmail: string;
    contactPhone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
  shipTo: {
    label: string;
    name: string;
    lines: string[];
    contactName: string;
    phone: string;
    email: string;
  };
  vendors: string[];
  vendor: {
    name: string;
    contactName: string;
    contactTitle: string;
    contactEmail: string;
    contactPhone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    accountNumber: string;
    paymentTerms: string;
    leadTimeDays: number | null;
    isSteelFabricator: boolean;
  } | null;
  lines: BomLine[];
  /**
   * What the sheet adds up to. Freight and tax are quoted on the deal and typed as
   * text ("TBD", "$1,240"), so each is carried both as it reads and, where it can
   * be read as a number, in minor units. The grand total exists only when both can.
   */
  financials: {
    itemCostMinor: number;
    shipmentQuote: string;
    shipmentMinor: number | null;
    estimatedTax: string;
    estimatedTaxMinor: number | null;
    grandTotalMinor: number | null;
  };
  totals: {
    lineCount: number;
    unitCount: number;
    extendedCostMinor: number;
    steelWeightLbs: number;
    totalWeightLbs: number;
  };
}

const s = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Street and suite on ONE line: "10488 Centennial Road, Suite 100".
 *
 * They were separate rows, which printed a bare "100" under the street and read as
 * a truncated address on a document going to a vendor.
 */
export const streetLine = (line1: unknown, line2: unknown): string => {
  const a = s(line1).trim();
  const b = s(line2).trim();
  if (!b) return a;
  if (!a) return b;
  // A suite that already says what it is keeps its own wording; a bare number gets
  // labelled, since "100" alone means nothing to whoever is delivering.
  const labelled =
    /^(ste|suite|apt|apartment|unit|#|bldg|building|fl|floor|rm|room|dept|po box|p\.o\.)/i.test(b);
  return `${a}, ${labelled ? b : `Suite ${b}`}`;
};

/**
 * Build one BOM. `vendor` is a vendor name, or '*' for every vendor combined.
 * `includeZeroQty` adds the rest of that vendor's catalogue at qty 0 — the
 * "full order form" style, so the shop can hand-add a part without a new sheet.
 */
/** "$1,240.50" / "1240.5" → 124050. Null when it is not a number at all ("TBD"). */
function parseMoneyMinor(v: unknown): number | null {
  const raw = String(v ?? '')
    .replace(/[$,\s]/g, '')
    .trim();
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

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
    prisma.user.findUnique({
      where: { id: order.acceptedById },
      select: { name: true, email: true, title: true },
    }),
    prisma.manufacturer.findMany(),
    prisma.proposal.findUnique({ where: { id: order.proposalId }, select: { title: true } }),
  ]);

  // The vendor's own section holds the fields that used to live on the order: where
  // this shipment goes, what its freight was quoted at, and the deal's tax figure.
  const section = vendorFilter
    ? await prisma.bomVendorSection.findUnique({
        where: { orderId_vendor: { orderId, vendor: vendorFilter } },
        include: { shipToAddress: true },
      })
    : null;

  const mfrByName = new Map(manufacturers.map((m) => [m.name.toLowerCase(), m]));
  const steelVendors = new Set(
    manufacturers.filter((m) => m.isSteelFabricator).map((m) => m.name.toLowerCase()),
  );

  // ---- ordering ----
  // The BOM follows the PRODUCT TREE, not the alphabet: the tree order is the order
  // the shop builds in, and `Product.sortOrder` is unique across the whole tree
  // (Adventure in the 20000s, Soar in the 40000s) which is exactly why it can be
  // sorted on its own. Header rows are deliberately not carried over — the sheet is
  // a parts list, and a category heading is not a part.
  const skusOnOrder = [...new Set(order.procurement.map((l) => s(l.sku)).filter(Boolean))];
  const treeRows = skusOnOrder.length
    ? await prisma.product.findMany({
        where: { sku: { in: skusOnOrder } },
        select: { sku: true, sortOrder: true },
      })
    : [];
  const treeOrderBySku = new Map(treeRows.map((p) => [p.sku, p.sortOrder]));

  // Packaging bag per part. Lives on the SKU rather than the line, so one edit in
  // the catalog re-labels every sheet that part appears on.
  const bagRows = skusOnOrder.length
    ? await prisma.sku.findMany({
        where: { part: { in: skusOnOrder } },
        select: { part: true, packagingBag: true },
      })
    : [];
  const bagBySku = new Map(bagRows.map((k) => [k.part, k.packagingBag ?? '']));

  // Hardware sorts to the end as its own block. Membership is decided by the
  // hardware RULES rather than a part-number pattern, so a fastener that does not
  // happen to start with 6820H- is still filed correctly.
  const hardwareParts = new Set<string>([
    'H-1000',
    ...(
      await prisma.hardwareRule.findMany({ where: { kind: 'HARDWARE' }, select: { part: true } })
    ).map((r) => r.part),
  ]);
  // A part quoted on the proposal under its own name (the zip-line eye bolt) is
  // still a fastener on the shop floor — bomRollup names those explicitly.
  const isHardwarePart = (sku: string, flagged: boolean): boolean =>
    flagged || hardwareParts.has(sku) || isRollupHardwarePart(sku);

  // A part the tree has never heard of would otherwise sort to position 0 and lead
  // the sheet. Park it after the known products but before hardware.
  const UNPLACED = 9_000_000;

  const ordered = [...order.procurement].sort((a, b) => {
    const aHw = isHardwarePart(s(a.sku), a.isHardwareComponent);
    const bHw = isHardwarePart(s(b.sku), b.isHardwareComponent);
    if (aHw !== bHw) return aHw ? 1 : -1;
    const ao = treeOrderBySku.get(s(a.sku)) ?? UNPLACED;
    const bo = treeOrderBySku.get(s(b.sku)) ?? UNPLACED;
    if (ao !== bo) return ao - bo;
    return (a.sku || '').localeCompare(b.sku || '');
  });
  const scoped = vendorFilter
    ? ordered.filter((l) => (s(l.vendor).trim() || 'Unassigned vendor') === vendorFilter)
    : ordered;

  // Every vendor part number that could apply to this sheet, in one query. Keyed
  // on vendor AND part: two vendors may number the same part differently.
  const vendorParts = await vendorPartLookup(
    ordered.map((l) => ({ vendor: s(l.vendor).trim() || 'Unassigned vendor', sku: s(l.sku) })),
  );

  const builtLines: BomLine[] = scoped.map((l) => {
    const qty = Number(l.quantity) || 0;
    // A free-issue part is already paid for. It prints at zero so it appears in the
    // shipment without asking the receiving vendor to buy it, and so it cannot land in
    // any total on their sheet. The real cost is untouched on the order line.
    const free = !!l.freeIssue;
    const cost = free ? 0 : (l.unitCostMinor ?? 0);
    const wt = l.unitWeightLbs == null ? 0 : Number(l.unitWeightLbs);
    const vendorName = s(l.vendor).trim() || 'Unassigned vendor';
    const vendorSku = vendorParts.get(vendorName, s(l.sku)) ?? '';
    // Said on the line itself rather than in a legend, so it survives every export
    // — Excel, PDF and the screen all read vendorNotes already.
    const freeNote = free
      ? `Supplied by ${COMPANY.name} at no charge${s(l.purchaseVendor) ? ` (from ${s(l.purchaseVendor)})` : ''} — do not invoice`
      : '';
    const notes = [s(l.vendorNotes), freeNote].filter(Boolean).join(' · ');
    return {
      id: l.id,
      lineNo: vendorSku || s(l.sku) || '—',
      sku: s(l.sku),
      vendorSku,
      name: l.name,
      quantity: qty,
      powderColor: s(l.powderColor),
      packagingBag: bagBySku.get(s(l.sku)) ?? '',
      unitCostMinor: cost,
      extendedCostMinor: cost * qty,
      unitWeightLbs: wt,
      extendedWeightLbs: Math.round(wt * qty * 1000) / 1000,
      vendor: vendorName,
      vendorNotes: notes,
      sourced: l.sourced,
      isSteel: steelVendors.has(vendorName.toLowerCase()),
      treeOrder: treeOrderBySku.get(s(l.sku)) ?? UNPLACED,
      isHardware: isHardwarePart(s(l.sku), l.isHardwareComponent),
      freeIssue: free,
      purchaseVendor: s(l.purchaseVendor),
    };
  });

  // Variant part numbers collapse into the part the vendor is actually sold: two
  // proposal lines, one purchase line. The proposal keeps both.
  const lines: BomLine[] = rollUpBomLines(builtLines);

  // ---- optional zero-quantity rows: the rest of this vendor's catalogue ----
  if (opts.includeZeroQty && vendorFilter && vendorFilter !== 'Unassigned vendor') {
    const have = new Set(lines.map((l) => l.sku).filter(Boolean));
    const mfr = mfrByName.get(vendorFilter.toLowerCase());
    const [skus, sourced] = await Promise.all([
      prisma.sku.findMany({
        where: { manufacturer: vendorFilter, active: true },
        select: { part: true, description: true, unitCostMinor: true, weightLbs: true },
      }),
      mfr
        ? prisma.productSourcing.findMany({
            where: { manufacturerId: mfr.id },
            select: { product: { select: { sku: true, name: true, status: true } } },
          })
        : Promise.resolve([] as Array<{ product: { sku: string; name: string; status: string } }>),
    ]);
    const extra = new Map<
      string,
      { sku: string; name: string; unitCostMinor: number; weightLbs: number }
    >();
    for (const k of skus) {
      if (!have.has(k.part))
        extra.set(k.part, {
          sku: k.part,
          name: k.description,
          unitCostMinor: k.unitCostMinor,
          weightLbs: Number(k.weightLbs),
        });
    }
    for (const r of sourced) {
      if (!have.has(r.product.sku) && !extra.has(r.product.sku) && r.product.status === 'ACTIVE') {
        extra.set(r.product.sku, {
          sku: r.product.sku,
          name: r.product.name,
          unitCostMinor: 0,
          weightLbs: 0,
        });
      }
    }
    const extraParts = await vendorPartLookup(
      [...extra.values()].map((e) => ({ vendor: vendorFilter, sku: e.sku })),
    );
    for (const e of [...extra.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
      const extraVendorSku = extraParts.get(vendorFilter, e.sku) ?? '';
      lines.push({
        id: `zero:${e.sku}`,
        lineNo: extraVendorSku || e.sku,
        sku: e.sku,
        vendorSku: extraVendorSku,
        name: e.name,
        quantity: 0,
        powderColor: '',
        packagingBag: bagBySku.get(e.sku) ?? '',
        unitCostMinor: e.unitCostMinor,
        extendedCostMinor: 0,
        unitWeightLbs: e.weightLbs,
        extendedWeightLbs: 0,
        vendor: vendorFilter,
        vendorNotes: '',
        sourced: false,
        isSteel: steelVendors.has(vendorFilter.toLowerCase()),
        treeOrder: UNPLACED,
        isHardware: isHardwarePart(e.sku, false),
        freeIssue: false,
        purchaseVendor: '',
      });
    }
  }

  // ---- customer block ----
  const ship = org?.addresses.find((a) => a.type === 'SHIPPING') ?? org?.addresses[0] ?? null;
  const contact = org?.contacts[0] ?? null;
  const customer = {
    name: org?.name ?? '',
    contactName: contact
      ? `${contact.firstName} ${contact.lastName}`.trim()
      : s(order.customerApproval?.approverName),
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
  const cityLine = (city: string, region: string, zip: string) =>
    [city, [region, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const named = section?.shipToAddress ?? null;
  const shipTo = named
    ? {
        label: named.name,
        name: named.name,
        lines: [
          streetLine(named.line1, named.line2),
          cityLine(s(named.city), s(named.region), s(named.postalCode)),
        ].filter(Boolean),
        contactName: s(named.contactName),
        phone: s(named.phone),
        email: s(named.email),
      }
    : order.bomShipTo === 'SUMMIT'
      ? {
          label: 'Summit Sensory Gym',
          name: COMPANY.name,
          lines: [
            COMPANY.addressLine1,
            cityLine(COMPANY.city, COMPANY.region, COMPANY.postalCode),
          ].filter(Boolean),
          contactName: creator?.name ?? '',
          phone: COMPANY.phone,
          email: COMPANY.email,
        }
      : {
          label: 'Customer site',
          name: customer.name,
          lines: [
            streetLine(customer.addressLine1, customer.addressLine2),
            cityLine(customer.city, customer.region, customer.postalCode),
          ].filter(Boolean),
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
    steelWeightLbs:
      Math.round(
        lines.filter((l) => l.isSteel).reduce((a, l) => a + l.extendedWeightLbs, 0) * 100,
      ) / 100,
    totalWeightLbs: Math.round(lines.reduce((a, l) => a + l.extendedWeightLbs, 0) * 100) / 100,
  };

  const vendors = [...new Set(ordered.map((l) => s(l.vendor).trim() || 'Unassigned vendor'))].sort(
    (a, b) => (a === 'Unassigned vendor' ? 1 : b === 'Unassigned vendor' ? -1 : a.localeCompare(b)),
  );

  return {
    order: {
      id: order.id,
      number: order.number,
      status: order.status,
      acceptedVersion: order.acceptedVersion,
      // Customer and order number, which between them identify the job on a vendor's
      // desk. The proposal title was the old fallback and is kept behind the explicit
      // job name, but ahead of nothing: a sheet with no job name is one more email
      // asking which job it is.
      jobName:
        s(order.jobName) || defaultJobName(s(org?.name), s(order.number)) || s(proposal?.title),
      shipTo: order.bomShipTo,
      submittedOn: order.bomSubmittedOn ? order.bomSubmittedOn.toISOString() : null,
      deliveryType: s(order.deliveryType),
      powderCoatBrand: s(order.powderCoatBrand),
      shipmentQuote: s(order.shipmentQuote),
      notes: s(order.bomNotes),
    },
    company: COMPANY,
    createdBy: creator
      ? { name: s(creator.name), email: s(creator.email), title: s(creator.title) }
      : null,
    createdAt: new Date().toISOString(),
    customer,
    shipTo,
    vendors,
    vendor,
    lines,
    financials: (() => {
      const itemCostMinor = totals.extendedCostMinor;
      const shipmentQuote = s(section?.shipmentQuote ?? order.shipmentQuote);
      // Tax belongs to ONE vendor's sheet, not to every vendor's.
      //
      // The deal carries a single tax figure for the job — the comment on DEAL_COL says
      // as much — so copying it onto each vendor section made a three-vendor order look
      // like it owed the tax three times, and each sheet's grand total was wrong by it.
      // It rides with the mats vendor (Resilite, whose bomFreightSource is MATS), which
      // keeps the rule in the same admin setting that already decides which freight
      // figure a vendor gets rather than hard-coding a vendor's name in the code.
      const carriesTax = mfr?.bomFreightSource === 'MATS';
      const estimatedTax = carriesTax ? s(section?.estimatedTax) : '';
      const shipmentMinor = parseMoneyMinor(shipmentQuote);
      const estimatedTaxMinor = parseMoneyMinor(estimatedTax);
      return {
        itemCostMinor,
        shipmentQuote,
        shipmentMinor,
        estimatedTax,
        estimatedTaxMinor,
        // Only a real total, never a partial one: a sheet whose freight still reads
        // TBD has no grand total, and saying so is better than printing a number
        // that quietly leaves the freight out.
        grandTotalMinor:
          shipmentMinor == null || (estimatedTax && estimatedTaxMinor == null)
            ? null
            : itemCostMinor + shipmentMinor + (estimatedTaxMinor ?? 0),
      };
    })(),
    totals,
  };
}

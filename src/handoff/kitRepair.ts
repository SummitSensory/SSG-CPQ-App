import { prisma } from '../lib/prisma.js';
import { procurementFromItems } from './lock.js';
import { expandBomBuild } from './bomBuild.js';
import { resolveCatalogRefs } from './service.js';
import {
  HARDWARE_KIT_SKU,
  isHardwareKitSku,
  withKitComponents,
  type KitComponentSource,
} from './kitComponents.js';

/**
 * Itemise the bundled H-1000 "Hardware Kit" line on orders that were locked without
 * the kit's fastener breakdown (see kitComponents.ts for how that happened).
 *
 * Lock time now derives the breakdown, but an order already locked keeps the single
 * kit line it was created with — the BOM is read from the stored procurement lines,
 * not rebuilt from the proposal when it is viewed or sent. So existing orders need
 * their lines repaired: the kit line is replaced by one line per fastener, exactly
 * as lock.ts would have created them.
 *
 * Idempotent: an order that already has lines carrying `kitSku = H-1000` is skipped,
 * and a repaired order has no bundled kit line left to find.
 *
 * Deliberately conservative. An order is SKIPPED, with the reason printed, when:
 *   - it is COMPLETE or CANCELLED;
 *   - the kit line is on a purchase order, or carries a PO number;
 *   - the kit's vendor section is SUBMITTED (locked) — unlock it first, so the vendor
 *     can be sent the corrected sheet;
 *   - the kit line's quantity was edited by hand;
 *   - there is more than one bundled kit line;
 *   - no breakdown can be derived (no itemised description, no configurator answers).
 * A section that was already EMAILED but has since been unlocked is repaired, with a
 * warning: the vendor holds the bundled version and must be re-sent the sheet.
 */

export interface PlannedLine {
  sku: string;
  name: string;
  quantity: number;
  vendor: string | null;
  unitCostMinor: number | null;
  unitWeightLbs: number | null;
}

export interface KitRepairPlan {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  kitLineId: string | null;
  kitVendor: string | null;
  source: KitComponentSource | null;
  action: 'repair' | 'skip';
  reason: string;
  warnings: string[];
  lines: PlannedLine[];
}

const FINISHED = ['COMPLETE', 'CANCELLED'] as const;

export async function planKitRepairs(
  opts: { orderNumbers?: string[] } = {},
): Promise<KitRepairPlan[]> {
  const orders = await prisma.acceptedOrder.findMany({
    where: {
      ...(opts.orderNumbers?.length ? { number: { in: opts.orderNumbers } } : {}),
      procurement: {
        some: {
          sku: { equals: HARDWARE_KIT_SKU, mode: 'insensitive' },
          isHardwareComponent: false,
        },
      },
    },
    orderBy: { number: 'asc' },
    select: {
      id: true,
      number: true,
      status: true,
      proposalVersionId: true,
      procurement: {
        select: {
          id: true,
          sku: true,
          quantity: true,
          quantityOriginal: true,
          vendor: true,
          poNumber: true,
          kitSku: true,
          isHardwareComponent: true,
          proposalLineOrder: true,
          bomGroup: true,
          bomPosition: true,
        },
      },
    },
  });

  const plans: KitRepairPlan[] = [];
  for (const o of orders) {
    const kits = o.procurement.filter((l) => isHardwareKitSku(l.sku) && !l.isHardwareComponent);
    const kit = kits[0] ?? null;
    const plan: KitRepairPlan = {
      orderId: o.id,
      orderNumber: o.number,
      orderStatus: o.status,
      kitLineId: kit?.id ?? null,
      kitVendor: kit?.vendor ?? null,
      source: null,
      action: 'skip',
      reason: '',
      warnings: [],
      lines: [],
    };
    plans.push(plan);

    if ((FINISHED as readonly string[]).includes(o.status)) {
      plan.reason = `order is ${o.status}`;
      continue;
    }
    if (o.procurement.some((l) => isHardwareKitSku(l.kitSku))) {
      plan.reason = 'already itemised (has lines from the H-1000 kit)';
      continue;
    }
    if (!kit) {
      plan.reason = 'no bundled kit line';
      continue;
    }
    if (kits.length > 1) {
      plan.reason = `${kits.length} bundled kit lines — repair by hand`;
      continue;
    }
    if (kit.poNumber) {
      plan.reason = `kit line is on purchase order ${kit.poNumber}`;
      continue;
    }
    const onPo = await prisma.purchaseOrderLine.count({
      where: {
        OR: [
          { procurementLineId: kit.id },
          {
            procurementLineId: null,
            sku: { equals: HARDWARE_KIT_SKU, mode: 'insensitive' },
            po: { orderId: o.id },
          },
        ],
      },
    });
    if (onPo) {
      plan.reason = 'kit line is on a purchase order';
      continue;
    }
    if (kit.quantityOriginal != null && kit.quantity !== kit.quantityOriginal) {
      plan.reason = `kit quantity was edited by hand (${kit.quantityOriginal} -> ${kit.quantity})`;
      continue;
    }

    const vendorName = (kit.vendor ?? '').trim() || 'Unassigned vendor';
    const section = await prisma.bomVendorSection.findFirst({
      where: { orderId: o.id, vendor: { equals: vendorName, mode: 'insensitive' } },
      select: { status: true, sends: { select: { sentAt: true }, orderBy: { sentAt: 'desc' } } },
    });
    if (section?.status === 'SUBMITTED') {
      plan.reason = `${vendorName} section is SUBMITTED — unlock it first`;
      continue;
    }
    if (section?.sends.length) {
      const last = section.sends[0]?.sentAt.toISOString().slice(0, 10);
      plan.warnings.push(
        `${vendorName} was already emailed this BOM ${section.sends.length}x (last ${last}) with the bundled kit — re-send the corrected sheet`,
      );
    }

    const version = await prisma.proposalVersion.findUnique({
      where: { id: o.proposalVersionId },
      select: { items: true, sections: true },
    });
    const { items, filled } = await withKitComponents(version?.items ?? [], version?.sections);
    const seeds = procurementFromItems(items).filter((s) => isHardwareKitSku(s.kitSku));
    if (!seeds.length || !filled.length) {
      plan.reason =
        'no breakdown can be derived (no itemised description, no configurator answers)';
      continue;
    }
    plan.source = filled[0]?.source ?? null;

    const expanded = await expandBomBuild(seeds);
    const refs = await resolveCatalogRefs(expanded);
    plan.lines = expanded.map((s, i) => {
      const ref = refs[i];
      return {
        sku: ref?.sku ?? s.sku ?? '',
        name: s.name,
        quantity: s.quantity,
        // The fastener's own catalog vendor, as at lock; the kit's vendor otherwise,
        // so nothing lands on a sheet nobody is going to send.
        vendor: s.vendorOverride ?? ref?.vendor ?? kit.vendor ?? null,
        unitCostMinor: s.forcedUnitCostMinor ?? ref?.unitCostMinor ?? s.unitCostMinor ?? null,
        unitWeightLbs: ref?.unitWeightLbs ?? s.unitWeightLbs ?? null,
      };
    });
    plan.action = 'repair';
    plan.reason = `replace 1 bundled H-1000 line with ${plan.lines.length} fastener lines (from the ${plan.source})`;
  }
  return plans;
}

/** Apply one plan. Re-checks idempotency inside the transaction. */
export async function applyKitRepair(plan: KitRepairPlan, actorId = 'system'): Promise<boolean> {
  if (plan.action !== 'repair' || !plan.kitLineId) return false;
  const kitLineId = plan.kitLineId;
  return prisma.$transaction(async (tx) => {
    const kit = await tx.procurementLine.findUnique({ where: { id: kitLineId } });
    if (!kit || kit.orderId !== plan.orderId) return false;
    const done = await tx.procurementLine.count({
      where: { orderId: plan.orderId, kitSku: { equals: HARDWARE_KIT_SKU, mode: 'insensitive' } },
    });
    if (done) return false;

    const notes = new Map(
      (
        await tx.sku.findMany({
          where: { part: { in: plan.lines.map((l) => l.sku) }, NOT: { bomNote: null } },
          select: { part: true, bomNote: true },
        })
      ).map((r) => [r.part.toUpperCase(), r.bomNote]),
    );

    await tx.procurementLine.createMany({
      data: plan.lines.map((l) => ({
        orderId: plan.orderId,
        productId: null,
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        quantityOriginal: l.quantity,
        vendor: l.vendor,
        unitCostMinor: l.unitCostMinor,
        unitWeightLbs: l.unitWeightLbs,
        isHardwareComponent: true,
        kitSku: HARDWARE_KIT_SKU,
        // Where the kit sat on the proposal and on the sheet, so the fasteners print
        // where the bundled line used to.
        proposalLineOrder: kit.proposalLineOrder,
        bomPosition: kit.bomPosition,
        bomGroup: kit.bomGroup,
        vendorNotes: notes.get(l.sku.toUpperCase())?.trim() || null,
      })),
    });
    await tx.procurementLine.delete({ where: { id: kit.id } });
    await tx.orderEvent.create({
      data: {
        orderId: plan.orderId,
        action: 'order.hardwareKitItemized',
        actorId,
        detail: {
          source: plan.source,
          removed: { sku: kit.sku, name: kit.name, quantity: kit.quantity, vendor: kit.vendor },
          added: plan.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, vendor: l.vendor })),
        } as object,
      },
    });
    return true;
  });
}

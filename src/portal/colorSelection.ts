import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import {
  specsForLines,
  normalizePicks,
  slotLabel,
  readPicks,
  describePicks,
  type ResolvedColorSpec,
  type ColorPick,
} from '../vendorColors/service.js';

/**
 * Customer colour selection, collected by the portal against the CRM's palettes.
 *
 * This is the replacement for the Jotform colour form, and it is deliberately
 * shipped switched off. `PORTAL_COLOR_SELECTION` has three settings:
 *
 *   off     Every endpoint refuses. Nothing about the current Jotform flow changes.
 *           This is the default, and what production runs until the parallel test
 *           passes.
 *   shadow  The customer can be sent a link and their picks are recorded, but
 *           nothing is written to the order. This is how the path gets proven on a
 *           real job: run Jotform as usual, run this beside it, compare.
 *   live    Picks may be applied to the order's procurement lines.
 *
 * The gate is checked in `assertEnabled`, not at the route, so no future caller can
 * reach the write path around it.
 *
 * Two things make this better than the form it replaces, and they are the reason
 * to do it at all. The customer can only choose colours the vendor actually makes,
 * because the list comes from the vendor's own palette. And the answer lands on the
 * procurement line the shop reads, with the vendor's own code beside the name —
 * not in a form response somebody transcribes.
 *
 * The thing it is WORSE at, which is a real cost and not a hypothetical: a
 * non-developer can edit a Jotform. Palette content is administered in the CRM
 * (Administration → Manufacturers → Colours), but the question wording and the
 * page around it are code. Before switching this on, confirm who at Summit edits
 * those forms today.
 */

export type ColorSelectionMode = 'off' | 'shadow' | 'live';

export function colorSelectionMode(): ColorSelectionMode {
  return env.PORTAL_COLOR_SELECTION;
}

function assertEnabled(): ColorSelectionMode {
  const mode = colorSelectionMode();
  if (mode === 'off') {
    throw new ValidationError(
      'Portal colour selection is switched off on this deployment. Set PORTAL_COLOR_SELECTION=shadow to run it beside the Jotform for one order first.',
    );
  }
  return mode;
}

const TOKEN_TTL_DAYS = 30;
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** One line the customer is being asked about. Frozen into the request when minted. */
export interface OfferedLine {
  lineId: string;
  sku: string | null;
  name: string;
  quantity: number;
  vendor: string | null;
  specId: string;
  paletteName: string;
  paletteVendor: string;
  finishType: string;
  slots: Array<{ slot: number; label: string }>;
  colors: Array<{ id: string; name: string; vendorCode: string | null }>;
  /** Whatever is already on the line, so a resubmission starts from it. */
  current: ColorPick[];
}

function offerFor(
  line: {
    id: string;
    sku: string | null;
    name: string;
    quantity: number;
    vendor: string | null;
    colorPicks: unknown;
  },
  spec: ResolvedColorSpec,
): OfferedLine {
  return {
    lineId: line.id,
    sku: line.sku,
    name: line.name,
    quantity: line.quantity,
    vendor: line.vendor,
    specId: spec.specId,
    paletteName: spec.palette.name,
    paletteVendor: spec.palette.manufacturerName,
    finishType: spec.palette.finishType,
    slots: Array.from({ length: spec.slotCount }, (_, i) => ({
      slot: i + 1,
      label: slotLabel(spec, i + 1),
    })),
    // No upcharges. A customer choosing a colour is not being quoted; the money
    // was settled on the accepted proposal, and showing a per-colour figure here
    // invites a conversation about a price that is already closed.
    colors: spec.colors.map((c) => ({ id: c.id, name: c.name, vendorCode: c.vendorCode })),
    current: readPicks(line.colorPicks),
  };
}

/** The lines on an order that take a colour choice, with their palettes. */
export async function offeredLines(orderId: string): Promise<OfferedLine[]> {
  const lines = await prisma.procurementLine.findMany({
    where: { orderId, isHardwareComponent: false },
    orderBy: [{ vendor: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      productId: true,
      sku: true,
      name: true,
      quantity: true,
      vendor: true,
      colorPicks: true,
    },
  });
  const specs = await specsForLines(lines);
  const out: OfferedLine[] = [];
  for (const line of lines) {
    const spec =
      specs.get(line.productId ?? '') ?? specs.get((line.sku ?? '').trim().toUpperCase());
    if (spec) out.push(offerFor(line, spec));
  }
  return out;
}

/**
 * Mint a colour-selection request for an order.
 *
 * The offered lines are frozen onto the record. A palette edited while the customer
 * has the link open must not change the question they were asked — and when the
 * picks are applied they are re-validated against the live palette anyway, so a
 * colour discontinued in the meantime is caught then, loudly, rather than accepted
 * quietly.
 *
 * Any earlier OPEN request for the order is voided: two live links for one job is
 * how two people answer and nobody knows which answer won.
 */
export async function createColorRequest(
  orderId: string,
  actorId: string,
): Promise<{ id: string; token: string; url: string | null; lines: OfferedLine[] }> {
  assertEnabled();
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, portalOrderItemId: true },
  });
  if (!order) throw new NotFoundError('Order not found');

  const lines = await offeredLines(orderId);
  if (!lines.length) {
    throw new ValidationError(
      'No line on this order takes a colour choice. Set a colour spec on the product first (Administration → Manufacturers → Colours).',
    );
  }

  await prisma.portalColorSelection.updateMany({
    where: { orderId, status: 'OPEN' },
    data: { status: 'VOID', note: 'Superseded by a newer request.' },
  });

  const token = randomBytes(32).toString('base64url');
  const row = await prisma.portalColorSelection.create({
    data: {
      orderId,
      mondayOrderItemId: order.portalOrderItemId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      offered: lines as unknown as object,
      createdById: actorId,
    },
  });

  const base = env.PORTAL_BASE_URL;
  return {
    id: row.id,
    token,
    url: base ? `${base.replace(/\/$/, '')}/portal/colors/${token}` : null,
    lines,
  };
}

/** The request behind a customer's link. Throws rather than leaking a reason. */
export async function loadByToken(token: string) {
  assertEnabled();
  const row = await prisma.portalColorSelection.findUnique({
    where: { tokenHash: hash(token) },
    include: { order: { select: { id: true, number: true, organizationId: true } } },
  });
  if (!row || row.status === 'VOID')
    throw new NotFoundError('That colour selection link is not valid');
  if (row.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('That colour selection link has expired. Ask us for a new one.');
  }
  return row;
}

/**
 * Record what the customer chose.
 *
 * Validated against the LIVE palette, not the frozen offer: the frozen offer is
 * what they were shown, and the live palette is what the vendor can still make.
 * When those disagree the customer has to be asked again, which is the honest
 * outcome even though it is the annoying one.
 *
 * Never applies. In shadow mode that is the point; in live mode applying is a
 * separate, deliberate act by a person (`applySelection`), because a colour reaching
 * a vendor sheet without anyone at Summit having looked at it is exactly the
 * failure the Jotform flow already has.
 */
export async function submitSelection(
  token: string,
  input: { email?: string; picks: Array<{ lineId: string; picks: unknown }> },
) {
  const mode = assertEnabled();
  const row = await loadByToken(token);
  if (row.status === 'APPLIED') {
    throw new ValidationError(
      'These colours have already been sent to production. Call us to change them.',
    );
  }

  const lines = await prisma.procurementLine.findMany({
    where: { orderId: row.orderId, id: { in: input.picks.map((p) => p.lineId) } },
    select: { id: true, productId: true, sku: true, name: true },
  });
  if (lines.length !== input.picks.length) {
    throw new ValidationError('One of those lines is not on this order.');
  }
  const specs = await specsForLines(lines);

  const stored: Array<{ lineId: string; sku: string | null; picks: ColorPick[]; label: string }> =
    [];
  for (const entry of input.picks) {
    const line = lines.find((l) => l.id === entry.lineId)!;
    const spec =
      specs.get(line.productId ?? '') ?? specs.get((line.sku ?? '').trim().toUpperCase());
    if (!spec) throw new ValidationError(`${line.name} does not take a colour choice.`);
    // requireComplete is off: a customer part-way through their choices should be
    // able to save. Completeness is enforced when the picks are applied.
    const picks = normalizePicks(spec, entry.picks, { requireComplete: false });
    stored.push({
      lineId: line.id,
      sku: line.sku,
      picks,
      label: describePicks(picks, { withVendorCode: true, spec }),
    });
  }

  const updated = await prisma.portalColorSelection.update({
    where: { id: row.id },
    data: {
      picks: stored as unknown as object,
      status: mode === 'live' ? 'SUBMITTED' : 'SHADOWED',
      submittedAt: new Date(),
      submittedByEmail: input.email?.trim() || null,
      note:
        mode === 'shadow'
          ? 'Recorded for comparison with the Jotform run. Nothing was written to the order.'
          : null,
    },
  });
  logger.info(
    { selectionId: updated.id, orderId: row.orderId, mode, lines: stored.length },
    'portal colour selection recorded',
  );
  return updated;
}

/**
 * Write a submitted selection onto the order's procurement lines.
 *
 * Refused in shadow mode — that is what shadow mode means. Refused for a section
 * that has already gone to the vendor, for the same reason a submitted BOM is not
 * edited anywhere else in this codebase: they are holding the sheet.
 */
export async function applySelection(selectionId: string, actorId: string) {
  const mode = assertEnabled();
  if (mode !== 'live') {
    throw new ValidationError(
      'Portal colour selection is in shadow mode, so these picks are recorded but cannot be applied. Compare them against the Jotform response first; set PORTAL_COLOR_SELECTION=live when you are satisfied.',
    );
  }
  const row = await prisma.portalColorSelection.findUnique({ where: { id: selectionId } });
  if (!row) throw new NotFoundError('Colour selection not found');
  if (row.status === 'APPLIED') return row;
  if (!Array.isArray(row.picks) || !row.picks.length) {
    throw new ValidationError('The customer has not chosen any colours yet.');
  }

  /*
   * The version of the picks this call is acting on.
   *
   * The customer's link stays valid for thirty days and keeps working after they
   * submit — deliberately, so they can come back and finish. submitSelection only
   * refuses once the status is APPLIED, and the status does not become APPLIED until
   * the very end of this function. So between the read above and the write below the
   * customer can change a colour, and nothing used to notice.
   *
   * What that produced was not a lost update, which would at least be visible. The
   * final update set the status but never re-wrote `picks`, so the row ended up
   * holding the customer's NEW choice while the procurement lines the shop reads
   * held the OLD one. The audit record and the vendor sheet disagreed, permanently
   * and silently, and the order event recorded only line names — so there was no
   * third copy to arbitrate between them.
   *
   * submittedAt changes on every submit, so it identifies the version. Claiming the
   * row on that value below turns the race into a refusal.
   */
  const reviewedAt = row.submittedAt;

  // Prisma types a Json column as JsonValue, which does not narrow to a shape by
  // assertion — via unknown, and only reading the two fields that matter. The picks
  // are re-validated against the live palette below anyway, so a malformed entry is
  // caught by normalizePicks rather than trusted here.
  const entries = (row.picks as unknown as Array<{ lineId?: unknown; picks?: unknown }>).filter(
    (e) => e && typeof e === 'object' && typeof e.lineId === 'string',
  ) as Array<{ lineId: string; picks: unknown }>;
  const lines = await prisma.procurementLine.findMany({
    where: { orderId: row.orderId, id: { in: entries.map((e) => e.lineId) } },
    select: { id: true, productId: true, sku: true, name: true, vendor: true },
  });

  // Outside the transaction on purpose: specsForLines reads the administered palettes
  // through the module-level client and cannot be handed `tx`. Palette content is not
  // racing with a customer's submit, and every pick is re-validated against it below.
  const specs = await specsForLines(lines);

  return prisma.$transaction(async (tx) => {
    /*
     * Claim the row before writing anything.
     *
     * updateMany rather than update because it reports how many rows matched, which
     * is the only way to ask "is this still the version I reviewed?" and act on the
     * answer. count === 0 means either the customer resubmitted or somebody else
     * applied it while this call was in flight; the throw rolls the transaction back
     * so no procurement line is left carrying a colour nobody approved.
     */
    const claim = await tx.portalColorSelection.updateMany({
      where: { id: row.id, status: { not: 'APPLIED' }, submittedAt: reviewedAt },
      data: { status: 'APPLIED', appliedAt: new Date(), appliedById: actorId },
    });
    if (claim.count !== 1) {
      throw new ValidationError(
        'These colours changed while you were reviewing them, so nothing was applied. Open the selection again and check the picks before applying.',
      );
    }

    // Read inside the transaction: a vendor's Bill of Materials being submitted is
    // what makes a line untouchable, and that can happen while this runs.
    const sections = await tx.bomVendorSection.findMany({
      where: { orderId: row.orderId },
      select: { vendor: true, status: true },
    });
    const frozenVendors = new Set(
      sections.filter((x) => x.status === 'SUBMITTED').map((x) => (x.vendor || '').toLowerCase()),
    );

    const applied: string[] = [];
    const skipped: string[] = [];
    // What actually reached the shop, colour by colour. The row's `picks` can still be
    // overwritten by a customer after this point; this cannot, so it is the record
    // that settles "what did we build against?"
    const record: Array<{ line: string; sku: string | null; colour: string }> = [];

    for (const entry of entries) {
      const line = lines.find((l) => l.id === entry.lineId);
      if (!line) continue;
      if (frozenVendors.has((line.vendor ?? '').toLowerCase())) {
        skipped.push(line.name);
        continue;
      }
      const spec =
        specs.get(line.productId ?? '') ?? specs.get((line.sku ?? '').trim().toUpperCase());
      if (!spec) {
        skipped.push(line.name);
        continue;
      }
      // Re-validated here, against the live palette, and completeness is enforced:
      // a line that goes to the shop half-specified comes back as a phone call.
      const picks = normalizePicks(spec, entry.picks, { requireComplete: spec.required });
      const colour = describePicks(picks, { withVendorCode: true, spec }) || null;
      await tx.procurementLine.update({
        where: { id: line.id },
        data: {
          colorPicks: picks as unknown as object,
          powderColor: colour,
        },
      });
      applied.push(line.name);
      record.push({ line: line.name, sku: line.sku, colour: colour ?? '' });
    }

    await tx.orderEvent.create({
      data: {
        orderId: row.orderId,
        action: 'bom.colors.portal',
        actorId,
        detail: { selectionId: row.id, applied, skipped, colours: record } as object,
      },
    });

    return tx.portalColorSelection.update({
      where: { id: row.id },
      data: {
        note: skipped.length
          ? `Applied to ${applied.length} line(s). ${skipped.length} skipped — their vendor's Bill of Materials is already submitted.`
          : `Applied to ${applied.length} line(s).`,
      },
    });
  });
}

/** Every colour request on an order, for the order screen and the parallel-run comparison. */
export async function listSelections(orderId: string) {
  const rows = await prisma.portalColorSelection.findMany({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    submittedByEmail: r.submittedByEmail,
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    lineCount: Array.isArray(r.offered) ? r.offered.length : 0,
    picks: r.picks ?? null,
    note: r.note,
  }));
}

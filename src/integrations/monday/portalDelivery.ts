import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { fetchAllItems, fetchItemById } from './discovery.js';
import { ensureSections } from '../../handoff/bomSections.js';

/**
 * Portal delivery details → the Bill of Materials.
 *
 * The customer portal has no database. It writes the customer's confirmed
 * delivery address to monday: onto the order's own row, and as one new row per
 * submission on the standalone Delivery & Site Details Submissions board. The CRM
 * is already subscribed to a signed monday webhook. So this is not a new
 * integration — it is the return leg of a loop that already runs one way.
 *
 * Four things shape the code below.
 *
 * **The portal writes ~30 columns one at a time, after creating the row.** So the
 * create event arrives with an empty row and the address turns up several events
 * later. Every event for a submissions row therefore re-reads the WHOLE row and
 * re-processes it; the PortalDeliverySubmission table makes that idempotent, and a
 * row with no usable address yet is INCOMPLETE rather than failed.
 *
 * **The join is not free.** The portal knows the Manufacturing Process item id.
 * `AcceptedOrder.mondayProjectId` is the Deal Tracking item id — a different board
 * and a different number. There is no column that relates them today, so this
 * resolves in a documented ladder (recorded link, then the customer's email) and
 * PARKS anything it cannot settle. The first successful match writes
 * `portalOrderItemId` onto the order, and every later submission for that order
 * resolves on it directly.
 *
 * **An address can legitimately arrive before the order exists.** The invite is
 * fired by a staff member setting a status column on the manufacturing board,
 * which has nothing to do with whether the deal has been imported into the CRM.
 * Parked submissions are retried and are visible; none is ever dropped.
 *
 * **A submitted section is the sheet a vendor already holds.** It is never
 * rewritten under them. If every candidate section is submitted, the order owner
 * is emailed and the submission is left CONFLICT for a human to unlock and apply.
 */

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * The submissions board and its columns, mirroring the portal's own
 * `lib/monday.js` (`DELIVERY_BOARD_ID`, `DELIVERY_COLS`). Every id is
 * env-overridable with the same defaults, so a column rebuilt in monday is a
 * config change on both sides rather than a deploy on either.
 */
export function deliveryBoardId(): string {
  return env.MONDAY_DELIVERY_BOARD_ID ?? '18421779422';
}

export const DELIVERY_COL = {
  orderItemId: 'text_mm571ym4',
  customerEmail: 'text_mm57c4dm',
  submittedDate: 'date_mm57s4r5',
  primaryPocName: 'text_mm57830j',
  primaryPocPhone: 'text_mm5767gr',
  primaryPocEmail: 'text_mm57qnte',
  specialInstructions: 'long_text_mm57e4q',
  secondaryPocName: 'text_mm57as86',
  secondaryPocPhone: 'text_mm576cps',
  secondaryPocEmail: 'text_mm57kmfe',
  loadingDock: 'text_mm5712dx',
  deliveryTiming: 'text_mm57q2s6',
  preferredDeliveryDate: 'date_mm57m9rp',
  addressConfirmed: 'text_mm572geh',
  addressLine1: 'text_mm57sf21',
  addressLine2: 'text_mm57mbr7',
  city: 'text_mm57g87z',
  stateProvince: 'text_mm57hhxm',
  postalCode: 'text_mm57wkbf',
  country: 'text_mm57n32a',
  formattedAddress: 'long_text_mm57vhh3',
  freightAckBy: 'text_mm57nnck',
  freightAckDate: 'date_mm578gmh',
  restrictedChanges: 'long_text_mm57r7b1',
} as const;

/** Inbound delivery details need a token to read the row and a board to read it from. */
export function isPortalDeliveryConfigured(): boolean {
  return Boolean(env.MONDAY_API_TOKEN && deliveryBoardId());
}

const s = (v: unknown): string => (v == null ? '' : String(v)).trim();
const orNull = (v: unknown): string | null => s(v) || null;

/** A monday date column reads back as YYYY-MM-DD. Anything else is not a date. */
function asDate(v: unknown): Date | null {
  const t = s(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(t.slice(0, 10) + 'T00:00:00.000Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The portal writes the literal strings "Yes"/"No"; blank means unanswered. */
function asYesNo(v: unknown): boolean | null {
  const t = s(v).toLowerCase();
  if (t === 'yes' || t === 'true') return true;
  if (t === 'no' || t === 'false') return false;
  return null;
}

export interface DeliveryFields {
  mondayOrderItemId: string;
  customerEmail: string | null;
  addressConfirmed: boolean | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  formattedAddress: string | null;
  pocName: string | null;
  pocPhone: string | null;
  pocEmail: string | null;
  secondaryPocName: string | null;
  secondaryPocPhone: string | null;
  secondaryPocEmail: string | null;
  loadingDock: string | null;
  deliveryTiming: string | null;
  preferredDeliveryDate: Date | null;
  specialInstructions: string | null;
  restrictedChanges: string | null;
  freightAckBy: string | null;
  freightAckDate: Date | null;
  raw: Record<string, string>;
}

function readFields(text: Record<string, string | null | undefined>): DeliveryFields {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(text)) if (s(v)) raw[k] = s(v);
  const c = DELIVERY_COL;
  return {
    mondayOrderItemId: s(text[c.orderItemId]),
    customerEmail: orNull(text[c.customerEmail]),
    addressConfirmed: asYesNo(text[c.addressConfirmed]),
    line1: orNull(text[c.addressLine1]),
    line2: orNull(text[c.addressLine2]),
    city: orNull(text[c.city]),
    region: orNull(text[c.stateProvince]),
    postalCode: orNull(text[c.postalCode]),
    country: orNull(text[c.country]),
    formattedAddress: orNull(text[c.formattedAddress]),
    pocName: orNull(text[c.primaryPocName]),
    pocPhone: orNull(text[c.primaryPocPhone]),
    pocEmail: orNull(text[c.primaryPocEmail]),
    secondaryPocName: orNull(text[c.secondaryPocName]),
    secondaryPocPhone: orNull(text[c.secondaryPocPhone]),
    secondaryPocEmail: orNull(text[c.secondaryPocEmail]),
    loadingDock: orNull(text[c.loadingDock]),
    deliveryTiming: orNull(text[c.deliveryTiming]),
    preferredDeliveryDate: asDate(text[c.preferredDeliveryDate]),
    specialInstructions: orNull(text[c.specialInstructions]),
    restrictedChanges: orNull(text[c.restrictedChanges]),
    freightAckBy: orNull(text[c.freightAckBy]),
    freightAckDate: asDate(text[c.freightAckDate]),
    raw,
  };
}

// --------------------------------------------------------------- address salvage
//
// Some portal submissions land with the discrete address columns empty and only
// `Full Ship-To Address Formatted` filled — the portal wrote the formatted string
// but not the per-field columns. The row is a real, customer-confirmed address; it
// just fails `isUsable` on a missing street, so it sat INCOMPLETE forever and never
// reached a vendor sheet.
//
// So: when the street is missing and a formatted address is present, split the
// formatted string back into fields. Only EMPTY fields are filled — anything monday
// actually sent always wins — and the salvage has to produce a street and a city or
// it is discarded and the row stays INCOMPLETE. A flag is written into `raw` so the
// address record says on its face that the street was read out of the formatted
// column rather than confirmed field by field.

/** Marker left in `raw` when the fields below came out of the formatted string. */
const PARSED_FLAG = '_addressParsedFromFormatted';

/**
 * The submissions row's own name, kept in `raw`.
 *
 * The portal names each row after the customer ("Soar Autism Center - Maryvale
 * Village", "Remedy Speech Therapy — 8/14/2026"), and that name is the only thing
 * that says WHOSE address a row carries. Without it a parked row is a bare street in
 * a city, and nobody can tell which order it belongs to — which is the one question
 * the person looking at it needs answered. Stored in `raw` rather than as a column so
 * this needs no migration.
 */
const ITEM_NAME = '_mondayItemName';

const COUNTRIES = new Set([
  'united states',
  'united states of america',
  'usa',
  'us',
  'u.s.',
  'u.s.a.',
  'canada',
  'ca',
  'mexico',
]);

const US_ZIP = /^\d{5}(?:-\d{4})?$/;
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;

export interface ParsedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * Split a formatted one-line address into fields, from the end inwards.
 *
 * "901 N Washington St, 320, Alexandria, Virginia 22314, United States"
 *   → line1 "901 N Washington St", line2 "320", city "Alexandria",
 *     region "Virginia", postal "22314", country "United States"
 *
 * Deliberately conservative: it reads the tail it recognises (country, then a
 * region/postal pair, then the city) and treats whatever is left at the front as
 * the street. It returns nulls rather than guessing when there is nothing to read.
 */
export function parseFormattedAddress(formatted: string | null | undefined): ParsedAddress {
  const empty: ParsedAddress = {
    line1: null,
    line2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
  };
  const parts = s(formatted)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return empty;

  let country: string | null = null;
  if (COUNTRIES.has(parts[parts.length - 1]!.toLowerCase().replace(/\.$/, ''))) {
    country = parts.pop()!;
  }
  if (!parts.length) return empty;

  // "Virginia 22314", "MO 64402", "ok 74070", "Ontario M5V 2T6", or just "Virginia".
  let region: string | null = null;
  let postalCode: string | null = null;
  const tail = parts.pop()!;
  const words = tail.split(/\s+/);
  const last = words[words.length - 1] ?? '';
  const lastTwo = words.slice(-2).join(' ');
  if (words.length > 1 && US_ZIP.test(last)) {
    postalCode = last;
    region = words.slice(0, -1).join(' ') || null;
  } else if (words.length > 2 && CA_POSTAL.test(lastTwo)) {
    postalCode = lastTwo;
    region = words.slice(0, -2).join(' ') || null;
  } else if (US_ZIP.test(tail) || CA_POSTAL.test(tail)) {
    postalCode = tail;
  } else {
    region = tail;
  }

  const city = parts.length ? parts.pop()! : null;
  const line1 = parts.length ? parts.shift()! : null;
  const line2 = parts.length ? parts.join(', ') : null;

  return { line1, line2, city, region, postalCode, country };
}

/**
 * Fill in whatever the portal left blank from the formatted address.
 *
 * A no-op unless the street is missing and the salvage yields both a street and a
 * city — a half-read address applied to a vendor sheet is the expensive outcome
 * this whole file is arranged to avoid.
 */
function withFormattedFallback<
  T extends {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    formattedAddress: string | null;
    raw?: Record<string, string>;
  },
>(fields: T): T {
  if (fields.line1 || !fields.formattedAddress) return fields;
  const p = parseFormattedAddress(fields.formattedAddress);
  const line1 = p.line1;
  const city = fields.city ?? p.city;
  if (!line1 || !city) return fields;
  return {
    ...fields,
    line1,
    line2: fields.line2 ?? p.line2,
    city,
    region: fields.region ?? p.region,
    postalCode: fields.postalCode ?? p.postalCode,
    country: fields.country ?? p.country,
    raw: { ...(fields.raw ?? {}), [PARSED_FLAG]: 'true' },
  };
}

/** Did this submission's street come out of the formatted column? */
function wasParsedFromFormatted(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>)[PARSED_FLAG]);
}

/** The submissions row's name, if it was captured. */
function itemNameOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>)[ITEM_NAME];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Enough of an address to send a truck to. Street and city are the test: a ZIP on
 * its own is not an address, and applying half of one to a vendor sheet is worse
 * than waiting for the rest of the column writes to land.
 *
 * Takes the two fields rather than a whole submission, so the same rule applies to
 * a row just read off monday and to one already stored.
 */
function isUsable(a: { line1: string | null; city: string | null }): boolean {
  return Boolean(a.line1 && a.city);
}

/** Order timeline actor for changes nobody here made. */
const PORTAL_ACTOR = 'system:portal';

export type IngestResult =
  'applied' | 'incomplete' | 'parked' | 'conflict' | 'failed' | 'notfound' | 'unchanged';

/**
 * Read one submissions-board row and take it as far as it can go.
 *
 * Safe to call repeatedly for the same row — that is the normal case, since the
 * portal fires one column-change event per field. Work is only redone when the row
 * has something new to say: an APPLIED submission whose address has not changed
 * returns 'unchanged' without touching the order.
 */
export async function ingestDeliverySubmission(mondayItemId: string): Promise<IngestResult> {
  if (!isPortalDeliveryConfigured()) return 'failed';

  const item = await fetchItemById(mondayItemId).catch((err) => {
    logger.error({ err, mondayItemId }, 'portal delivery: could not read the submissions row');
    return null;
  });
  if (!item) return 'notfound';

  // The salvage runs here, before the change comparison, so a row whose street was
  // read out of the formatted column still counts as unchanged on the next event.
  const fields = withFormattedFallback(readFields(item.text ?? {}));
  if (item.name) fields.raw[ITEM_NAME] = item.name;
  if (wasParsedFromFormatted(fields.raw)) {
    logger.warn(
      { mondayItemId, city: fields.city },
      'portal delivery: street read from the formatted address column — the portal did not write the separate address fields',
    );
  }
  const existing = await prisma.portalDeliverySubmission.findUnique({ where: { mondayItemId } });

  const sameAddress =
    existing &&
    existing.line1 === fields.line1 &&
    existing.line2 === fields.line2 &&
    existing.city === fields.city &&
    existing.region === fields.region &&
    existing.postalCode === fields.postalCode &&
    existing.country === fields.country;

  // Nothing new, and the last run finished the job. This is the common path: 29 of
  // the 30 column events for a submission end here.
  if (existing && existing.status === 'APPLIED' && sameAddress) {
    // Nothing to redo — but if this row was stored before the name was captured,
    // take it now. A backfill is then enough to label every historical row.
    const priorRaw = (existing.raw as Record<string, string> | null) ?? {};
    if (item.name && priorRaw[ITEM_NAME] !== item.name) {
      await prisma.portalDeliverySubmission.update({
        where: { id: existing.id },
        data: { raw: { ...priorRaw, [ITEM_NAME]: item.name } as object },
      });
    }
    return 'unchanged';
  }

  const data = {
    mondayOrderItemId: fields.mondayOrderItemId,
    customerEmail: fields.customerEmail,
    addressConfirmed: fields.addressConfirmed,
    line1: fields.line1,
    line2: fields.line2,
    city: fields.city,
    region: fields.region,
    postalCode: fields.postalCode,
    country: fields.country,
    formattedAddress: fields.formattedAddress,
    pocName: fields.pocName,
    pocPhone: fields.pocPhone,
    pocEmail: fields.pocEmail,
    secondaryPocName: fields.secondaryPocName,
    secondaryPocPhone: fields.secondaryPocPhone,
    secondaryPocEmail: fields.secondaryPocEmail,
    loadingDock: fields.loadingDock,
    deliveryTiming: fields.deliveryTiming,
    preferredDeliveryDate: fields.preferredDeliveryDate,
    specialInstructions: fields.specialInstructions,
    restrictedChanges: fields.restrictedChanges,
    freightAckBy: fields.freightAckBy,
    freightAckDate: fields.freightAckDate,
    raw: fields.raw as object,
  };

  const sub = await prisma.portalDeliverySubmission.upsert({
    where: { mondayItemId },
    create: { mondayItemId, ...data, attempts: 1 },
    update: { ...data, attempts: { increment: 1 } },
  });

  return processSubmission(sub.id);
}

/**
 * Take a stored submission as far as it can go. Split out from the read so a
 * parked row can be retried, and linked by hand, without going back to monday.
 */
export async function processSubmission(submissionId: string): Promise<IngestResult> {
  let sub = await prisma.portalDeliverySubmission.findUnique({ where: { id: submissionId } });
  if (!sub) return 'notfound';

  // A row stored before the salvage existed keeps its formatted address, so it can
  // be rescued from what is already in the database — no monday read needed.
  if (!isUsable(sub) && sub.formattedAddress) {
    const salvaged = withFormattedFallback({
      line1: sub.line1,
      line2: sub.line2,
      city: sub.city,
      region: sub.region,
      postalCode: sub.postalCode,
      country: sub.country,
      formattedAddress: sub.formattedAddress,
      raw: (sub.raw as Record<string, string> | null) ?? {},
    });
    if (isUsable(salvaged)) {
      sub = await prisma.portalDeliverySubmission.update({
        where: { id: sub.id },
        data: {
          line1: salvaged.line1,
          line2: salvaged.line2,
          city: salvaged.city,
          region: salvaged.region,
          postalCode: salvaged.postalCode,
          country: salvaged.country,
          raw: salvaged.raw as object,
        },
      });
      logger.warn(
        { submissionId: sub.id },
        'portal delivery: stored row rescued from its formatted address column',
      );
    }
  }

  const fieldsUsable = isUsable(sub);
  if (!fieldsUsable) {
    await prisma.portalDeliverySubmission.update({
      where: { id: sub.id },
      data: {
        status: 'INCOMPLETE',
        note: sub.formattedAddress
          ? 'The row has a formatted address but no street that can be read out of it, and the separate address columns are empty. Check the submissions board row, or type the address on the order by hand.'
          : 'No street and city on the row yet — the portal writes its columns one at a time, so this is normal for a few seconds after a submission.',
      },
    });
    return 'incomplete';
  }

  const resolved = sub.orderId ?? (await resolveOrderId(sub.mondayOrderItemId, sub.customerEmail));
  if (typeof resolved !== 'string') {
    await prisma.portalDeliverySubmission.update({
      where: { id: sub.id },
      data: { status: 'PARKED', note: resolved.note },
    });
    logger.warn(
      { submissionId: sub.id, orderItemId: sub.mondayOrderItemId },
      'portal delivery: parked — no order matched',
    );
    return 'parked';
  }

  try {
    return await applyToOrder(sub.id, resolved);
  } catch (err) {
    logger.error({ err, submissionId: sub.id }, 'portal delivery: apply failed');
    await prisma.portalDeliverySubmission.update({
      where: { id: sub.id },
      data: { status: 'FAILED', note: err instanceof Error ? err.message : String(err) },
    });
    return 'failed';
  }
}

/**
 * Which CRM order a portal submission belongs to.
 *
 * Two rungs, and no guessing past them:
 *
 *   1. **A recorded link.** `AcceptedOrder.portalOrderItemId`. Exact, and the only
 *      rung that runs once an order has been matched even once.
 *   2. **The customer's email**, which the portal carries on every submission. If
 *      exactly one live order belongs to an organization with a contact at that
 *      address, that is the order, and the link is recorded so rung 1 answers
 *      next time.
 *
 * Anything else — no match, or several candidates — parks with the reason in
 * words. A wrong address on a vendor sheet is far more expensive than a parked
 * row somebody has to look at.
 */
async function resolveOrderId(
  mondayOrderItemId: string,
  customerEmail: string | null,
): Promise<string | { note: string }> {
  if (mondayOrderItemId) {
    const linked = await prisma.acceptedOrder.findFirst({
      where: { portalOrderItemId: mondayOrderItemId },
      select: { id: true },
    });
    if (linked) return linked.id;
  }

  const email = (customerEmail ?? '').trim().toLowerCase();
  if (!email) {
    return {
      note: `No order is linked to monday item ${mondayOrderItemId || '(none)'} and the submission carries no customer email. Link it by hand from Settings → Integrations.`,
    };
  }

  const contacts = await prisma.contact.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { organizationId: true },
  });
  const orgIds = [...new Set(contacts.map((c) => c.organizationId))];
  if (!orgIds.length) {
    return {
      note: `No contact in the CRM has the email ${email}, so this submission cannot be matched to an order yet. It will be retried, or link it by hand.`,
    };
  }

  const candidates = await prisma.acceptedOrder.findMany({
    where: { organizationId: { in: orgIds }, status: { not: 'CANCELLED' } },
    orderBy: { acceptedAt: 'desc' },
    select: { id: true, number: true },
  });
  if (!candidates.length) {
    return {
      note: `${email} is a known contact, but their organization has no accepted order in the CRM yet. Held until it does.`,
    };
  }
  if (candidates.length > 1) {
    return {
      note: `${email} has ${candidates.length} open orders (${candidates.map((c) => c.number).join(', ')}) — which one the customer meant cannot be inferred. Link it by hand.`,
    };
  }

  const orderId = candidates[0]!.id;
  if (mondayOrderItemId) {
    await prisma.acceptedOrder
      .update({ where: { id: orderId }, data: { portalOrderItemId: mondayOrderItemId } })
      .catch((err) => {
        // Unique violation means another order already claims this manufacturing
        // row. Not fatal — the match still stands for this submission — but it is
        // worth knowing about.
        logger.warn(
          { err, orderId, mondayOrderItemId },
          'portal delivery: could not record the portal link',
        );
      });
  }
  return orderId;
}

/** A stable name for the address in the picker, so it reads as what it is. */
function addressName(orderNumber: string, customerName: string): string {
  return `${customerName} — confirmed by customer (${orderNumber})`;
}

/**
 * Put the confirmed address on the order's vendor sections.
 *
 * The address is one ShipToAddress per order, updated in place on a resubmission,
 * so a customer who corrects their ZIP does not leave two near-identical entries
 * in everyone's picker — and every section pointing at it follows the correction.
 *
 * With one exception, which is the whole conflict rule: if a SUBMITTED section
 * already points at that address, it is not edited, because a vendor is holding a
 * sheet printed from it. A second address record is created instead, the editable
 * sections are moved onto it, and the owner is emailed about the ones that were not.
 */
async function applyToOrder(submissionId: string, orderId: string): Promise<IngestResult> {
  const sub = await prisma.portalDeliverySubmission.findUnique({ where: { id: submissionId } });
  if (!sub) throw new NotFoundError('Submission not found');

  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, organizationId: true, proposalId: true },
  });
  if (!order) throw new NotFoundError('Order not found');
  const org = await prisma.organization.findUnique({
    where: { id: order.organizationId },
    select: { name: true },
  });

  // A vendor added to procurement after lock still needs a section to write to.
  await ensureSections(orderId, PORTAL_ACTOR);

  const addressData = {
    line1: sub.line1,
    line2: sub.line2,
    city: sub.city,
    region: sub.region,
    postalCode: sub.postalCode,
    country: sub.country ?? 'USA',
    contactName: sub.pocName,
    phone: sub.pocPhone,
    email: sub.pocEmail,
    notes:
      [
        sub.specialInstructions ? `Delivery instructions: ${sub.specialInstructions}` : null,
        sub.restrictedChanges ? `Flagged for staff confirmation: ${sub.restrictedChanges}` : null,
        sub.addressConfirmed === false ? 'Customer CHANGED the address on file.' : null,
        wasParsedFromFormatted(sub.raw)
          ? 'Street read from the portal’s formatted address line because the separate address fields were empty. Check it before a sheet goes out.'
          : null,
      ]
        .filter(Boolean)
        .join('\n') || null,
    source: 'PORTAL',
  };

  const sections = await prisma.bomVendorSection.findMany({
    where: { orderId },
    select: { id: true, vendor: true, status: true, shipToAddressId: true },
  });
  const editable = sections.filter((x) => x.status !== 'SUBMITTED');
  const frozen = sections.filter((x) => x.status === 'SUBMITTED');

  // Reuse this order's existing portal address unless a sent sheet is printed
  // from it and the address has changed.
  const prior = sub.shipToAddressId
    ? await prisma.shipToAddress.findUnique({ where: { id: sub.shipToAddressId } })
    : await prisma.shipToAddress.findFirst({
        where: { source: 'PORTAL', name: addressName(order.number, org?.name ?? '') },
        orderBy: { createdAt: 'desc' },
      });
  const priorIsFrozen = prior ? frozen.some((f) => f.shipToAddressId === prior.id) : false;

  let address;
  if (prior && !priorIsFrozen) {
    address = await prisma.shipToAddress.update({ where: { id: prior.id }, data: addressData });
  } else {
    const suffix = priorIsFrozen ? ` — revised ${new Date().toISOString().slice(0, 10)}` : '';
    address = await prisma.shipToAddress.create({
      data: {
        name: addressName(order.number, org?.name ?? '') + suffix,
        ...addressData,
        createdById: null,
      },
    });
  }

  if (!editable.length) {
    await prisma.portalDeliverySubmission.update({
      where: { id: sub.id },
      data: {
        orderId,
        shipToAddressId: address.id,
        status: 'CONFLICT',
        sectionsUpdated: 0,
        skippedVendors: frozen.map((f) => f.vendor).join(', ') || null,
        note: 'Every vendor section on this order is already submitted, so nothing was changed. The address is saved and can be applied by unlocking a section.',
        resolvedAt: new Date(),
      },
    });
    await notifyConflict(
      order.id,
      order.number,
      address.id,
      frozen.map((f) => f.vendor),
    );
    return 'conflict';
  }

  for (const sec of editable) {
    await prisma.bomVendorSection.update({
      where: { id: sec.id },
      data: {
        shipToAddressId: address.id,
        loadingDock: sub.loadingDock,
        deliveryTiming: sub.deliveryTiming,
        preferredDeliveryDate: sub.preferredDeliveryDate,
      },
    });
  }
  await prisma.orderEvent.create({
    data: {
      orderId,
      action: 'bom.shipTo.portal',
      actorId: PORTAL_ACTOR,
      detail: {
        submissionId: sub.id,
        mondayItemId: sub.mondayItemId,
        addressId: address.id,
        addressConfirmedByCustomer: sub.addressConfirmed,
        addressParsedFromFormatted: wasParsedFromFormatted(sub.raw),
        vendorsUpdated: editable.map((x) => x.vendor),
        vendorsSkipped: frozen.map((x) => x.vendor),
      } as object,
    },
  });

  await prisma.portalDeliverySubmission.update({
    where: { id: sub.id },
    data: {
      orderId,
      shipToAddressId: address.id,
      status: 'APPLIED',
      sectionsUpdated: editable.length,
      skippedVendors: frozen.map((f) => f.vendor).join(', ') || null,
      note: frozen.length
        ? `Applied to ${editable.length} section(s). ${frozen.length} already submitted and left alone.`
        : `Applied to ${editable.length} section(s).`,
      resolvedAt: new Date(),
    },
  });

  // A sheet that has gone out with the old address is a phone call, not a silent
  // difference in the database.
  if (frozen.length) {
    await notifyConflict(
      order.id,
      order.number,
      address.id,
      frozen.map((f) => f.vendor),
    );
  }
  return 'applied';
}

/** Link a parked submission to an order by hand, and finish the job. */
export async function linkSubmission(submissionId: string, orderId: string): Promise<IngestResult> {
  const sub = await prisma.portalDeliverySubmission.findUnique({ where: { id: submissionId } });
  if (!sub) throw new NotFoundError('Submission not found');
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { id: true, portalOrderItemId: true },
  });
  if (!order) throw new ValidationError('That order does not exist');

  // Record the link so every later submission for this order resolves without a
  // human. Silent no-op if the order already carries a different one.
  if (!order.portalOrderItemId && sub.mondayOrderItemId) {
    await prisma.acceptedOrder
      .update({ where: { id: orderId }, data: { portalOrderItemId: sub.mondayOrderItemId } })
      .catch(() => undefined);
  }
  await prisma.portalDeliverySubmission.update({
    where: { id: submissionId },
    data: { orderId },
  });
  return processSubmission(submissionId);
}

/**
 * Retry the submissions that are waiting on something — a parked address whose
 * order has since been imported, a row whose columns had not landed, a failed
 * read. Called from the integrations screen and safe to call on a schedule.
 */
export async function retryPendingSubmissions(limit = 25): Promise<{
  checked: number;
  results: Record<string, number>;
}> {
  const pending = await prisma.portalDeliverySubmission.findMany({
    where: { status: { in: ['PARKED', 'INCOMPLETE', 'FAILED'] } },
    orderBy: { receivedAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, mondayItemId: true, status: true },
  });
  const results: Record<string, number> = {};
  for (const p of pending) {
    // INCOMPLETE means the row itself was thin, so go back to monday for it;
    // anything else can be finished from what is already stored.
    const r =
      p.status === 'INCOMPLETE'
        ? await ingestDeliverySubmission(p.mondayItemId)
        : await processSubmission(p.id);
    results[r] = (results[r] ?? 0) + 1;
  }
  return { checked: pending.length, results };
}

/**
 * Sweep the whole submissions board and ingest every row that carries an address.
 *
 * Webhooks are not retroactive. A row created before the CRM subscribed to the
 * board never fired an event, so it is invisible here no matter how many times the
 * retry sweep runs — the retry sweep only looks at submissions the CRM has already
 * stored. That is how a board full of confirmed addresses can sit beside a CRM that
 * has seen one of them.
 *
 * This reads the board directly and puts every row through the ordinary ingest, so
 * a backfill and a webhook produce the same result. Idempotent: a row already
 * APPLIED with an unchanged address returns 'unchanged' and nothing is touched.
 *
 * `max` bounds the run so it finishes inside a serverless request; run it again to
 * continue. Rows with no address at all are skipped without being stored, so an
 * empty invite row on the board does not become a permanent INCOMPLETE record.
 */
export async function backfillFromBoard(max = 100): Promise<{
  scanned: number;
  ingested: number;
  skipped: number;
  results: Record<string, number>;
  rows: Array<{ mondayItemId: string; name: string; result: IngestResult }>;
}> {
  if (!isPortalDeliveryConfigured()) {
    return { scanned: 0, ingested: 0, skipped: 0, results: { failed: 1 }, rows: [] };
  }

  const items = await fetchAllItems(deliveryBoardId(), 250, Math.min(Math.max(max, 1), 500));
  const results: Record<string, number> = {};
  const rows: Array<{ mondayItemId: string; name: string; result: IngestResult }> = [];
  let ingested = 0;
  let skipped = 0;

  for (const item of items) {
    const f = readFields(item.text ?? {});
    // No street and nothing to read one out of: an invite row the customer has not
    // filled in, not a submission. A city and state alone is not an address, and
    // storing it would put a permanently INCOMPLETE record into the retry sweep,
    // which then re-reads it from monday on every run forever.
    if (!f.line1 && !f.formattedAddress) {
      skipped += 1;
      continue;
    }
    const result = await ingestDeliverySubmission(item.id);
    results[result] = (results[result] ?? 0) + 1;
    rows.push({ mondayItemId: item.id, name: item.name, result });
    ingested += 1;
  }

  logger.info(
    { scanned: items.length, ingested, skipped, results },
    'portal delivery: board backfill',
  );
  return { scanned: items.length, ingested, skipped, results, rows };
}

/**
 * Tell the order's owner that a vendor is holding a sheet with the old address.
 *
 * Returns a reason string rather than throwing: failing to send an email must not
 * undo an address that was applied correctly.
 */
async function notifyConflict(
  orderId: string,
  orderNumber: string,
  addressId: string,
  vendors: string[],
): Promise<string | null> {
  // AcceptedOrder carries proposalId as a scalar — there is no `proposal`
  // relation to traverse (the link is a recorded fact, not a cascade path), so the
  // owning rep takes a second read.
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: { proposalId: true },
  });
  const proposal = order
    ? await prisma.proposal.findUnique({
        where: { id: order.proposalId },
        select: { createdById: true },
      })
    : null;
  const ownerId = proposal?.createdById;
  const owner = ownerId
    ? await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } })
    : null;
  const to = [owner?.email, env.BOM_BCC_EMAIL].filter(Boolean) as string[];
  if (!to.length) return 'No order owner email and no BOM_BCC_EMAIL — nobody was told.';
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not set — nobody was told.';

  const address = await prisma.shipToAddress.findUnique({ where: { id: addressId } });
  const lines = [
    address?.line1,
    address?.line2,
    [address?.city, address?.region, address?.postalCode].filter(Boolean).join(', '),
  ].filter(Boolean);

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to,
        reply_to: env.BOM_REPLY_TO,
        subject: `${orderNumber}: customer confirmed a delivery address after a BOM was sent`,
        text: [
          `The customer has confirmed their delivery address for ${orderNumber} through the portal.`,
          '',
          ...lines,
          '',
          `These vendor sections are already submitted, so nothing was changed on them: ${vendors.join(', ')}.`,
          '',
          'If the address differs from what they were sent, unlock the section and re-send it.',
        ].join('\n'),
      }),
    });
    if (!res.ok) return `Resend rejected the notification (${res.status})`;
    return null;
  } catch (e) {
    return `Could not send the notification: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Delete the stored submissions that have no address at all.
 *
 * These are invite rows on the board that nobody has filled in. They were recorded
 * by an earlier, more lenient backfill, and they cost something: the retry sweep
 * re-reads every INCOMPLETE row from monday on each run, so a dozen empty rows are a
 * dozen pointless API calls a day, forever.
 *
 * Only rows with no street AND no formatted address go. Anything that has ever
 * carried an address stays, whatever its status — a record of something a customer
 * actually submitted is not ours to throw away. Should a deleted row ever be filled
 * in on the board, the webhook or the next backfill brings it back.
 */
export async function purgeAddresslessIncomplete(): Promise<{ deleted: number }> {
  const res = await prisma.portalDeliverySubmission.deleteMany({
    where: {
      status: 'INCOMPLETE',
      line1: null,
      formattedAddress: null,
      shipToAddressId: null,
      orderId: null,
    },
  });
  logger.info({ deleted: res.count }, 'portal delivery: purged address-less submissions');
  return { deleted: res.count };
}

/** Recent submissions for the integrations screen, newest first. */
export async function listSubmissions(limit = 100) {
  const rows = await prisma.portalDeliverySubmission.findMany({
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    include: {
      order: { select: { id: true, number: true } },
      shipToAddress: { select: { id: true, name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    receivedAt: r.receivedAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    attempts: r.attempts,
    mondayItemId: r.mondayItemId,
    mondayOrderItemId: r.mondayOrderItemId,
    order: r.order ? { id: r.order.id, number: r.order.number } : null,
    customerEmail: r.customerEmail,
    // Whose submission this is. The panel leads with it: an address with no name
    // beside it cannot be checked by anyone.
    itemName: itemNameOf(r.raw),
    address: [r.line1, r.city, r.region, r.postalCode].filter(Boolean).join(', ') || null,
    // A row with a city but no street still has nothing to ship to, and the panel
    // needs the same test the purge uses rather than guessing from `address`.
    hasStreet: !!r.line1,
    hasFormattedAddress: !!r.formattedAddress,
    addressConfirmedByCustomer: r.addressConfirmed,
    addressParsedFromFormatted: wasParsedFromFormatted(r.raw),
    pocName: r.pocName,
    pocPhone: r.pocPhone,
    shipToAddress: r.shipToAddress,
    sectionsUpdated: r.sectionsUpdated,
    skippedVendors: r.skippedVendors,
    loadingDock: r.loadingDock,
    deliveryTiming: r.deliveryTiming,
    preferredDeliveryDate: r.preferredDeliveryDate
      ? r.preferredDeliveryDate.toISOString().slice(0, 10)
      : null,
    note: r.note,
  }));
}

/**
 * The address the customer confirmed for a proposal, if they have. Used by the
 * freight RFQ, which otherwise ships to the organization's billing address.
 */
export async function confirmedAddressForProposal(proposalId: string) {
  const sub = await prisma.portalDeliverySubmission.findFirst({
    where: { status: 'APPLIED', order: { proposalId }, shipToAddressId: { not: null } },
    orderBy: { receivedAt: 'desc' },
    include: { shipToAddress: true },
  });
  return sub?.shipToAddress ?? null;
}

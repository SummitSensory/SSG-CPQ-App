import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import type { BomQuestionType, BomSectionStatus, BomShipTo } from '@prisma/client';
import { dealFigures, freightFor } from './dealFigures.js';

/**
 * Bill of Materials — per-vendor sections.
 *
 * The BOM header used to be one record on the order: one submission date, one
 * set of vendor notes, one lock for every vendor at once. A section is that
 * header scoped to a single vendor, so the fabricator and the distributor can be
 * prepared, confirmed and sent independently.
 *
 * Three rules hold everywhere in this file:
 *
 *   1. Sections are DERIVED from the procurement lines. A vendor with lines
 *      always has a section; nothing here invents a vendor.
 *   2. A SUBMITTED section is frozen. Every writer goes through `assertEditable`,
 *      so there is exactly one place that decides what "locked" means.
 *   3. Every change is written to the order's own timeline (OrderEvent) with the
 *      actor, so the order page can show who changed what and when.
 */

/** The vendor name used for lines the catalog has no manufacturer for. */
export const UNASSIGNED = 'Unassigned vendor';

const vendorOf = (v: string | null | undefined): string => (v && v.trim()) || UNASSIGNED;

/** Alphabetical, with the unassigned bucket pinned last — matches the printed order. */
const byVendorName = (a: string, b: string): number =>
  a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b);

async function logEvent(
  orderId: string,
  action: string,
  actorId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await prisma.orderEvent.create({
    data: { orderId, action, actorId, detail: (detail ?? {}) as object },
  });
}

/**
 * Create a section for every vendor on the order that doesn't have one yet.
 *
 * A new section inherits the order-level header — those columns are still the
 * per-order defaults — and a copy of the vendor's question templates. Existing
 * sections are never touched, so this is safe to call on every page load.
 */
/**
 * The job name a vendor sheet carries by default.
 *
 * Customer and sales order number, which between them identify the job on a vendor's
 * desk with nobody typing anything: the vendor knows us by the order number and knows
 * the job by the customer. It was a free-text field, so it was usually left blank, and a
 * vendor sheet with no job name is one more email asking which job it is.
 *
 * A default, not a rule — whatever is typed into the field wins and stays. Blanking the
 * field returns it to this.
 */
export function defaultJobName(
  customerName: string | null | undefined,
  orderNumber: string | null | undefined,
): string {
  return [String(customerName ?? '').trim(), String(orderNumber ?? '').trim()]
    .filter(Boolean)
    .join(' - ');
}

export async function ensureSections(orderId: string, actorId?: string): Promise<void> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      jobName: true,
      bomShipTo: true,
      bomSubmittedOn: true,
      deliveryType: true,
      powderCoatBrand: true,
      shipmentQuote: true,
      bomNotes: true,
      procurement: { select: { vendor: true } },
      bomSections: { select: { vendor: true, sortOrder: true } },
    },
  });
  if (!order) throw new NotFoundError('Order not found');

  const have = new Set(order.bomSections.map((s) => s.vendor));
  const wanted = [...new Set(order.procurement.map((l) => vendorOf(l.vendor)))].sort(byVendorName);
  const missing = wanted.filter((v) => !have.has(v));
  if (!missing.length) return;

  // Continue the existing numbering rather than renumbering — a section the
  // operator has already dragged into place keeps its position.
  let next = order.bomSections.reduce((m, s) => Math.max(m, s.sortOrder), 0);

  // A powder-coating vendor's new section starts with the colour column already on.
  const colorVendors = new Set(
    (
      await prisma.manufacturer.findMany({
        where: { bomShowPowderColor: true },
        select: { name: true },
      })
    ).map((m) => m.name),
  );

  const templates = await prisma.bomQuestionTemplate.findMany({
    where: { active: true, OR: [{ vendor: null }, { vendor: { in: missing } }] },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
  });

  for (const vendor of missing) {
    next += 10;
    const mine = templates.filter((t) => t.vendor === null || t.vendor === vendor);
    await prisma.bomVendorSection.create({
      data: {
        orderId,
        vendor,
        sortOrder: next,
        jobName: order.jobName,
        shipTo: order.bomShipTo,
        submittedOn: order.bomSubmittedOn,
        deliveryType: order.deliveryType,
        powderCoatBrand: order.powderCoatBrand,
        shipmentQuote: order.shipmentQuote,
        notes: order.bomNotes,
        showPowderColor: colorVendors.has(vendor),
        answers: {
          create: mine.map((t, i) => ({
            templateId: t.id,
            label: t.label,
            type: t.type,
            options: (t.options ?? undefined) as object | undefined,
            required: t.required,
            sortOrder: (i + 1) * 10,
          })),
        },
      },
    });
    if (actorId) await logEvent(orderId, 'bom.section.created', actorId, { vendor });
  }
}

export interface SectionView {
  id: string;
  vendor: string;
  sortOrder: number;
  jobName: string | null;
  shipTo: BomShipTo;
  /**
   * The stored submission date, or null. `submittedOnDefault` is what an
   * unsubmitted section should SHOW — today — without writing a date the
   * operator never chose.
   */
  submittedOn: string | null;
  submittedOnDefault: string;
  deliveryType: string | null;
  /**
   * The three delivery answers the customer gave in the portal. Separate fields,
   * not appended to `deliveryType`: that one is free text a human writes, and
   * running four answers together makes all four unreadable and none reportable.
   * Null on any order the customer has not answered for.
   */
  loadingDock: string | null;
  deliveryTiming: string | null;
  preferredDeliveryDate: string | null;
  powderCoatBrand: string | null;
  shipmentQuote: string | null;
  /** Informational: the deal's tax figure. Only the mats vendor's sheet carries it. */
  estimatedTax: string | null;
  notes: string | null;
  /** A named address instead of the customer's site or Summit's dock. */
  shipToAddressId: string | null;
  shipToAddress: {
    id: string;
    name: string;
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    contactName: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  /** Which of the deal's two freight figures this vendor's shipment is quoted from. */
  freightSource: string;
  /** Whether the deal's single tax figure belongs on this vendor's sheet. */
  showsEstimatedTax: boolean;
  status: BomSectionStatus;
  /** Whether this vendor's sheet prints the powder-colour column. */
  showPowderColor: boolean;
  /** Whether this vendor's sheet prints the packaging-bag column. */
  showPackagingBag: boolean;
  editable: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  unlockedAt: string | null;
  unlockedBy: string | null;
  lineCount: number;
  unitCount: number;
  extendedCostMinor: number;
  /** Parts on this section that require a colour and don't have one yet. */
  missingColorSkus: string[];
  questions: Array<{
    id: string;
    label: string;
    type: BomQuestionType;
    options: string[];
    required: boolean;
    value: string | null;
    sortOrder: number;
    fromTemplate: boolean;
  }>;
  sends: Array<{
    id: string;
    toEmail: string;
    ccEmails: string | null;
    subject: string;
    format: string;
    status: string;
    error: string | null;
    sentAt: string;
    sentBy: string | null;
    deliveredAt: string | null;
    openedAt: string | null;
  }>;
  email: {
    to: string;
    cc: string;
    subject: string;
    body: string;
    format: string;
    /** False when the vendor has no default address — the dialog then asks for one. */
    hasDefault: boolean;
  };
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const today = (): string => new Date().toISOString().slice(0, 10);

/** Fill {{token}} placeholders in a vendor's saved email defaults. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

/**
 * Matches the attachment filename exactly: `Customer_Name-Order_Number-Vendor_Name`.
 * A vendor searching their inbox for the subject finds the same string as the file
 * they saved, which is the whole point of the two agreeing.
 */
const DEFAULT_SUBJECT = '{{customer}}-{{order}}-{{vendor}}';
const DEFAULT_BODY = [
  'Hello,',
  '',
  'Attached is the Bill of Materials for {{customer}} ({{order}}).',
  '',
  'Please confirm receipt and let us know the expected ship date.',
  '',
  'Thank you,',
  'Summit Sensory Gym',
].join('\n');

/**
 * Every section on an order, with the totals, questions, send history and
 * pre-filled email each one needs. Calls `ensureSections` first so a vendor
 * added to the procurement list after lock still gets a section.
 */
export async function listSections(orderId: string, actorId?: string): Promise<SectionView[]> {
  await ensureSections(orderId, actorId);

  const [order, sections, lines, manufacturers] = await Promise.all([
    prisma.acceptedOrder.findUnique({
      where: { id: orderId },
      select: { number: true, jobName: true, organizationId: true },
    }),
    prisma.bomVendorSection.findMany({
      where: { orderId },
      orderBy: [{ sortOrder: 'asc' }, { vendor: 'asc' }],
      include: {
        answers: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] },
        sends: { orderBy: { sentAt: 'desc' } },
        shipToAddress: true,
      },
    }),
    prisma.procurementLine.findMany({
      where: { orderId },
      select: {
        sku: true,
        vendor: true,
        quantity: true,
        unitCostMinor: true,
        powderColorCode: true,
        powderColor: true,
        isHardwareComponent: true,
      },
    }),
    prisma.manufacturer.findMany({
      select: {
        name: true,
        bomEmailTo: true,
        bomEmailCc: true,
        bomEmailSubject: true,
        bomEmailBody: true,
        bomEmailFormat: true,
        contactEmail: true,
        bomFreightSource: true,
      },
    }),
  ]);
  if (!order) throw new NotFoundError('Order not found');

  // The customer leads both the subject and the attachment name, so it is resolved
  // once here rather than per section.
  const org = await prisma.organization.findUnique({
    where: { id: order.organizationId },
    select: { name: true },
  });
  const customerName = org?.name ?? '';
  const defaultJob = defaultJobName(customerName, order.number);

  // Which parts insist on a colour. Off by default, so this is usually a short list.
  const skusNeedingColor = new Set(
    (
      await prisma.sku.findMany({ where: { requiresPowderColor: true }, select: { part: true } })
    ).map((s) => s.part),
  );

  const actorIds = [
    ...new Set(
      sections.flatMap((s) => [s.confirmedById, s.unlockedById]).filter(Boolean) as string[],
    ),
  ];
  const senderIds = [...new Set(sections.flatMap((s) => s.sends.map((x) => x.sentById)))];
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set([...actorIds, ...senderIds])] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const mfrByName = new Map(manufacturers.map((m) => [m.name.toLowerCase(), m]));

  return sections.map((s) => {
    const mine = lines.filter((l) => vendorOf(l.vendor) === s.vendor);
    const mfr = mfrByName.get(s.vendor.toLowerCase());
    const vars = {
      vendor: s.vendor,
      customer: customerName,
      order: order.number,
      job: s.jobName || order.jobName || defaultJob,
      submittedOn: s.submittedOn ? s.submittedOn.toISOString().slice(0, 10) : today(),
    };
    const to = (mfr?.bomEmailTo || mfr?.contactEmail || '').trim();
    return {
      id: s.id,
      vendor: s.vendor,
      sortOrder: s.sortOrder,
      jobName: s.jobName || defaultJob,
      /** What the field falls back to when it is cleared, so the UI can show it. */
      jobNameDefault: defaultJob,
      shipTo: s.shipTo,
      submittedOn: iso(s.submittedOn),
      submittedOnDefault: today(),
      deliveryType: s.deliveryType,
      loadingDock: s.loadingDock,
      deliveryTiming: s.deliveryTiming,
      preferredDeliveryDate: s.preferredDeliveryDate
        ? s.preferredDeliveryDate.toISOString().slice(0, 10)
        : null,
      powderCoatBrand: s.powderCoatBrand,
      shipmentQuote: s.shipmentQuote,
      estimatedTax: s.estimatedTax,
      notes: s.notes,
      shipToAddressId: s.shipToAddressId,
      shipToAddress: s.shipToAddress
        ? {
            id: s.shipToAddress.id,
            name: s.shipToAddress.name,
            line1: s.shipToAddress.line1,
            line2: s.shipToAddress.line2,
            city: s.shipToAddress.city,
            region: s.shipToAddress.region,
            postalCode: s.shipToAddress.postalCode,
            country: s.shipToAddress.country,
            contactName: s.shipToAddress.contactName,
            phone: s.shipToAddress.phone,
            email: s.shipToAddress.email,
          }
        : null,
      freightSource: mfr?.bomFreightSource ?? 'STRUCTURE',
      /**
       * Whether the deal's tax figure belongs on this vendor's sheet.
       *
       * The deal carries ONE tax figure for the job, so showing it against every vendor
       * made a three-vendor order look like it owed the tax three times and left each
       * sheet's grand total overstated by it. It rides with the mats vendor, which keeps
       * the rule in the same setting that already decides which freight figure a vendor
       * gets instead of hard-coding a name.
       */
      showsEstimatedTax: (mfr?.bomFreightSource ?? 'STRUCTURE') === 'MATS',
      status: s.status,
      // Forced on when a line already carries a colour: hiding the column under a
      // vendor who has been given one would drop information from their sheet.
      showPowderColor:
        s.showPowderColor || mine.some((l) => (l.powderColorCode || l.powderColor || '').trim()),
      showPackagingBag: s.showPackagingBag,
      editable: s.status !== 'SUBMITTED',
      confirmedAt: iso(s.confirmedAt),
      confirmedBy: s.confirmedById ? (nameById.get(s.confirmedById) ?? null) : null,
      unlockedAt: iso(s.unlockedAt),
      unlockedBy: s.unlockedById ? (nameById.get(s.unlockedById) ?? null) : null,
      lineCount: mine.filter((l) => (Number(l.quantity) || 0) > 0).length,
      unitCount: mine.reduce((a, l) => a + (Number(l.quantity) || 0), 0),
      extendedCostMinor: mine.reduce(
        (a, l) => a + (l.unitCostMinor ?? 0) * (Number(l.quantity) || 0),
        0,
      ),
      missingColorSkus: mine
        .filter(
          (l) =>
            l.sku &&
            skusNeedingColor.has(l.sku) &&
            !(l.powderColorCode || '').trim() &&
            !(l.powderColor || '').trim(),
        )
        .map((l) => l.sku as string),
      questions: s.answers.map((a) => ({
        id: a.id,
        label: a.label,
        type: a.type,
        options: Array.isArray(a.options) ? (a.options as unknown[]).map(String) : [],
        required: a.required,
        value: a.value,
        sortOrder: a.sortOrder,
        fromTemplate: !!a.templateId,
      })),
      sends: s.sends.map((x) => ({
        id: x.id,
        toEmail: x.toEmail,
        ccEmails: x.ccEmails,
        subject: x.subject,
        format: x.format,
        status: x.status,
        error: x.error,
        sentAt: x.sentAt.toISOString(),
        sentBy: nameById.get(x.sentById) ?? null,
        deliveredAt: iso(x.deliveredAt),
        openedAt: iso(x.openedAt),
      })),
      email: {
        to,
        cc: (mfr?.bomEmailCc || '').trim(),
        subject: renderTemplate(mfr?.bomEmailSubject || DEFAULT_SUBJECT, vars),
        body: renderTemplate(mfr?.bomEmailBody || DEFAULT_BODY, vars),
        format: mfr?.bomEmailFormat || 'PDF',
        hasDefault: !!to,
      },
    };
  });
}

async function loadSection(sectionId: string) {
  const s = await prisma.bomVendorSection.findUnique({ where: { id: sectionId } });
  if (!s) throw new NotFoundError('Bill of Materials section not found');
  return s;
}

/**
 * The single gate on writing to a section. A SUBMITTED section is the document a
 * vendor already has; changing it silently would put the shop and the sheet out
 * of step, so the operator has to unlock it on purpose.
 */
function assertEditable(s: { status: BomSectionStatus; vendor: string }): void {
  if (s.status === 'SUBMITTED') {
    throw new ValidationError(
      `The ${s.vendor} Bill of Materials is submitted. Unlock it for changes first.`,
    );
  }
}

export interface SectionPatch {
  showPowderColor?: boolean;
  showPackagingBag?: boolean;
  jobName?: string | null;
  shipTo?: BomShipTo;
  /** Null clears it and falls back to `shipTo`. */
  shipToAddressId?: string | null;
  estimatedTax?: string | null;
  submittedOn?: Date | null;
  deliveryType?: string | null;
  loadingDock?: string | null;
  deliveryTiming?: string | null;
  preferredDeliveryDate?: Date | null;
  powderCoatBrand?: string | null;
  shipmentQuote?: string | null;
  notes?: string | null;
}

export async function patchSection(sectionId: string, patch: SectionPatch, actorId: string) {
  const s = await loadSection(sectionId);
  assertEditable(s);
  const data: Record<string, unknown> = {};
  for (const k of [
    'jobName',
    'shipTo',
    'shipToAddressId',
    'submittedOn',
    'deliveryType',
    'loadingDock',
    'deliveryTiming',
    'preferredDeliveryDate',
    'powderCoatBrand',
    'shipmentQuote',
    'estimatedTax',
    'notes',
    'showPowderColor',
    'showPackagingBag',
  ] as const) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  if (!Object.keys(data).length) return s;
  const updated = await prisma.bomVendorSection.update({ where: { id: sectionId }, data });
  // Log the fields that changed and their before/after, so the timeline reads as
  // a history rather than "something was edited".
  const changes: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    const before = (s as unknown as Record<string, unknown>)[k];
    const after = (updated as unknown as Record<string, unknown>)[k];
    if (String(before ?? '') !== String(after ?? ''))
      changes[k] = { from: before ?? null, to: after ?? null };
  }
  if (Object.keys(changes).length) {
    await logEvent(s.orderId, 'bom.section.updated', actorId, { vendor: s.vendor, changes });
  }
  return updated;
}

/**
 * Confirm the BOM has been sent to this vendor. Freezes the section's fields and
 * stamps a submission date if the operator never set one — the date shown on
 * screen was today, so that is what gets written.
 */
export async function confirmSection(sectionId: string, actorId: string) {
  const s = await loadSection(sectionId);
  if (s.status === 'SUBMITTED') return s;
  const updated = await prisma.bomVendorSection.update({
    where: { id: sectionId },
    data: {
      status: 'SUBMITTED',
      confirmedAt: new Date(),
      confirmedById: actorId,
      submittedOn: s.submittedOn ?? new Date(),
    },
  });
  await logEvent(s.orderId, 'bom.section.confirmed', actorId, {
    vendor: s.vendor,
    submittedOn: updated.submittedOn?.toISOString() ?? null,
  });
  return updated;
}

/** Re-open a submitted section. Reason is required — this is a deliberate act. */
export async function unlockSection(sectionId: string, reason: string, actorId: string) {
  const s = await loadSection(sectionId);
  if (!reason.trim())
    throw new ValidationError('Give a reason for unlocking this Bill of Materials');
  if (s.status !== 'SUBMITTED') return s;
  const updated = await prisma.bomVendorSection.update({
    where: { id: sectionId },
    data: { status: 'DRAFT', unlockedAt: new Date(), unlockedById: actorId },
  });
  await logEvent(s.orderId, 'bom.section.unlocked', actorId, {
    vendor: s.vendor,
    reason: reason.trim(),
  });
  return updated;
}

/** Sections in the order the ids arrive. Drives both the screen and the exports. */
export async function reorderSections(
  orderId: string,
  ids: string[],
  actorId: string,
): Promise<void> {
  const mine = await prisma.bomVendorSection.findMany({
    where: { orderId },
    select: { id: true, vendor: true },
  });
  const known = new Set(mine.map((s) => s.id));
  if (ids.some((id) => !known.has(id)))
    throw new ValidationError('That section is not on this order');
  await prisma.$transaction(
    ids.map((id, i) =>
      prisma.bomVendorSection.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } }),
    ),
  );
  const nameById = new Map(mine.map((s) => [s.id, s.vendor]));
  await logEvent(orderId, 'bom.sections.reordered', actorId, {
    order: ids.map((id) => nameById.get(id)),
  });
}

/**
 * Pull the deal's freight and tax onto this order's sections.
 *
 * Each section takes the freight figure its vendor quotes from — the mats vendor
 * the mats line, everyone else the structure line — and every section gets the one
 * tax figure. Submitted sections are skipped: they are the sheet the vendor already
 * holds. A figure typed by hand is only replaced when `overwrite` is set, so a
 * negotiated number is not silently undone by a refresh.
 */
export async function pullDealFigures(
  orderId: string,
  opts: { overwrite?: boolean } = {},
  actorId?: string,
): Promise<{ figures: Awaited<ReturnType<typeof dealFigures>>; updated: number; skipped: number }> {
  const figures = await dealFigures(orderId);
  if (figures.error) return { figures, updated: 0, skipped: 0 };

  const sections = await prisma.bomVendorSection.findMany({
    where: { orderId },
    select: { id: true, vendor: true, status: true, shipmentQuote: true, estimatedTax: true },
  });
  const mfrs = await prisma.manufacturer.findMany({
    select: { name: true, bomFreightSource: true },
  });
  const sourceByVendor = new Map(mfrs.map((m) => [m.name.toLowerCase(), m.bomFreightSource]));

  let updated = 0;
  let skipped = 0;
  for (const sec of sections) {
    if (sec.status === 'SUBMITTED') {
      skipped++;
      continue;
    }
    const freight = freightFor(
      figures,
      sourceByVendor.get(sec.vendor.toLowerCase()) ?? 'STRUCTURE',
    );
    const carriesTax = (sourceByVendor.get(sec.vendor.toLowerCase()) ?? 'STRUCTURE') === 'MATS';
    const data: Record<string, unknown> = {};
    const blank = (v: string | null) => !v || !v.trim() || v.trim().toUpperCase() === 'TBD';
    if (freight && (opts.overwrite || blank(sec.shipmentQuote))) data.shipmentQuote = freight;
    if (carriesTax && figures.estimatedTax && (opts.overwrite || blank(sec.estimatedTax))) {
      data.estimatedTax = figures.estimatedTax;
    }
    // Clear a tax figure copied onto a vendor that should never have carried one. The
    // sheet already hides it, but leaving the value behind would have it reappear the
    // day someone changes which vendor quotes the mats.
    if (!carriesTax && !blank(sec.estimatedTax)) data.estimatedTax = null;
    if (!Object.keys(data).length) {
      skipped++;
      continue;
    }
    await prisma.bomVendorSection.update({ where: { id: sec.id }, data });
    updated++;
    if (actorId) {
      await logEvent(orderId, 'bom.deal.figures', actorId, { vendor: sec.vendor, ...data });
    }
  }
  return { figures, updated, skipped };
}

// ---------------------------------------------------------------- questions

export interface QuestionInput {
  label: string;
  type: BomQuestionType;
  options?: string[];
  required?: boolean;
}

const CHOICE_TYPES = new Set<BomQuestionType>(['SELECT', 'MULTI_SELECT']);

function cleanOptions(type: BomQuestionType, options: string[] | undefined): string[] {
  if (!CHOICE_TYPES.has(type)) return [];
  const list = [...new Set((options ?? []).map((o) => String(o).trim()).filter(Boolean))];
  if (!list.length) throw new ValidationError('A dropdown needs at least one option');
  return list;
}

/** Add a question to one section only — the ad-hoc case ("what gauge for this job?"). */
export async function addQuestion(sectionId: string, input: QuestionInput, actorId: string) {
  const s = await loadSection(sectionId);
  assertEditable(s);
  if (!input.label.trim()) throw new ValidationError('A question needs a label');
  const last = await prisma.bomVendorAnswer.findFirst({
    where: { sectionId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  const q = await prisma.bomVendorAnswer.create({
    data: {
      sectionId,
      label: input.label.trim(),
      type: input.type,
      options: cleanOptions(input.type, input.options) as unknown as object,
      required: !!input.required,
      sortOrder: (last?.sortOrder ?? 0) + 10,
    },
  });
  await logEvent(s.orderId, 'bom.question.added', actorId, {
    vendor: s.vendor,
    label: q.label,
    type: q.type,
  });
  return q;
}

/** Answer a question, or edit its wording/choices while the section is open. */
export async function updateQuestion(
  questionId: string,
  patch: {
    value?: string | null;
    label?: string;
    options?: string[];
    required?: boolean;
    sortOrder?: number;
  },
  actorId: string,
) {
  const existing = await prisma.bomVendorAnswer.findUnique({
    where: { id: questionId },
    include: { section: true },
  });
  if (!existing) throw new NotFoundError('Question not found');
  assertEditable(existing.section);

  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new ValidationError('A question needs a label');
    data.label = patch.label.trim();
  }
  if (patch.options !== undefined)
    data.options = cleanOptions(existing.type, patch.options) as unknown as object;
  if (patch.required !== undefined) data.required = patch.required;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.value !== undefined) {
    const v = patch.value === null ? null : String(patch.value);
    // A choice answer has to be one of the choices, or the export prints a value
    // the vendor's own form doesn't offer.
    if (v && CHOICE_TYPES.has(existing.type)) {
      const allowed = new Set(
        Array.isArray(existing.options) ? (existing.options as unknown[]).map(String) : [],
      );
      const picked = existing.type === 'MULTI_SELECT' ? (JSON.parse(v) as string[]) : [v];
      for (const p of picked)
        if (!allowed.has(p))
          throw new ValidationError(`“${p}” is not an option for “${existing.label}”`);
    }
    data.value = v;
  }
  if (!Object.keys(data).length) return existing;

  const q = await prisma.bomVendorAnswer.update({ where: { id: questionId }, data });
  await logEvent(existing.section.orderId, 'bom.question.updated', actorId, {
    vendor: existing.section.vendor,
    label: q.label,
    ...(patch.value !== undefined
      ? { answer: { from: existing.value ?? null, to: q.value ?? null } }
      : {}),
  });
  return q;
}

export async function deleteQuestion(questionId: string, actorId: string): Promise<void> {
  const existing = await prisma.bomVendorAnswer.findUnique({
    where: { id: questionId },
    include: { section: true },
  });
  if (!existing) throw new NotFoundError('Question not found');
  assertEditable(existing.section);
  await prisma.bomVendorAnswer.delete({ where: { id: questionId } });
  await logEvent(existing.section.orderId, 'bom.question.removed', actorId, {
    vendor: existing.section.vendor,
    label: existing.label,
  });
}

/**
 * Guard for the confirm action: a required question with no answer, or a part
 * that insists on a colour and hasn't got one, blocks submission.
 */
export async function submissionBlockers(sectionId: string): Promise<string[]> {
  const s = await prisma.bomVendorSection.findUnique({
    where: { id: sectionId },
    include: { answers: true },
  });
  if (!s) throw new NotFoundError('Bill of Materials section not found');
  const out: string[] = [];
  for (const a of s.answers) {
    if (a.required && !(a.value ?? '').trim()) out.push(`“${a.label}” has no answer`);
  }
  const lines = await prisma.procurementLine.findMany({
    where: { orderId: s.orderId },
    select: { sku: true, vendor: true, powderColorCode: true, powderColor: true },
  });
  const needs = new Set(
    (
      await prisma.sku.findMany({ where: { requiresPowderColor: true }, select: { part: true } })
    ).map((x) => x.part),
  );
  for (const l of lines) {
    if (vendorOf(l.vendor) !== s.vendor) continue;
    if (
      l.sku &&
      needs.has(l.sku) &&
      !(l.powderColorCode || '').trim() &&
      !(l.powderColor || '').trim()
    ) {
      out.push(`${l.sku} needs a powder colour`);
    }
  }
  return out;
}

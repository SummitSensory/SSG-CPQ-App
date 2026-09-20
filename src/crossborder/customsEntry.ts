/**
 * The customs figures on a proposal, entered by a person.
 *
 * There is no tariff calculator in this version, and that is a decision rather than
 * an omission: classifying goods needs a tariff number, a country of origin, CUSMA
 * origin documentation, material composition and current surtax orders, and this
 * database holds none of it. A duty computed from absent data is worse than no duty,
 * because it produces a figure somebody will quote to a customer.
 *
 * So the flow is the honest one:
 *
 *   1. Every Canadian proposal starts at REQUIRES_CUSTOMS_REVIEW with every amount
 *      null. Null is not zero — nobody has answered yet.
 *   2. Somebody who prices freight enters what the broker quoted, with a reference
 *      to the quote. The entry becomes ESTIMATED.
 *   3. Somebody with authority approves it. It becomes CONFIRMED, and only then can
 *      the proposal go out as a landed-cost quote.
 *
 * Every step is audited with the previous value, because these figures move what a
 * customer owes.
 */
import { prisma } from '../lib/prisma.js';
import { recordAudit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { Prisma } from '@prisma/client';
import type { ProposalCustomsEntry } from '@prisma/client';
import { normalizeSectionCItems, type SectionCItem } from './sectionC.js';

export type ImporterOfRecordValue = 'CUSTOMER' | 'SUMMIT' | 'THIRD_PARTY' | 'TO_BE_DETERMINED';

export interface CustomsEntryPatch {
  /** Percent entry rather than typed amounts — see simpleCharges.ts. */
  simpleMode?: boolean;
  taxLabel?: string | null;
  /** Thousandths of a percent: 13% is 13000, Quebec's 9.975% is 9975. */
  taxPercentMilli?: number | null;
  tariffPercentMilli?: number | null;
  tariffOnFreight?: boolean;
  taxOnDuty?: boolean;
  currency?: 'USD' | 'CAD';
  dutyMinor?: number | null;
  surtaxMinor?: number | null;
  simaMinor?: number | null;
  otherDutyMinor?: number | null;
  importTaxMinor?: number | null;
  brokerFeeMinor?: number | null;
  brokerFeeScheduleId?: string | null;
  sourceReference?: string | null;
  basis?: string | null;
  importerOfRecord?: ImporterOfRecordValue;
  includedInSellerTotal?: boolean;
  notes?: string | null;
  /**
   * The customs/tariff classification code, typed in by a person. Never inferred,
   * parsed, validated against a tariff schedule, or used to compute a duty — see the
   * header comment on this file. Travels with the proposal so it can print on the
   * document; entering and standing behind the correct code is Summit's
   * responsibility, not the software's.
   */
  tariffClassificationCode?: string | null;
  /**
   * Whether these goods are entered under tariff item 9979.00.00 (disability-relief).
   * Never computed or inferred — a judgment call for Summit and its broker, not this
   * software. true = claimed, false = affirmatively not claimed, null = not yet
   * answered.
   */
  tariff9979Claimed?: boolean | null;
  /**
   * A human-entered STATUS about whether medical/assistive-device GST/HST relief is
   * being claimed — distinct from the tax-rate calculation engine and from taxLabel.
   * Never inferred; null means undetermined.
   */
  gstHstTreatment?: 'STANDARD_RATE' | 'MEDICAL_DEVICE_RELIEF_CLAIMED' | null;
  /**
   * The Summit system model this proposal's components belong to, when this proposal
   * is for replacement/expansion parts rather than a new complete system. Typed in by
   * a person, never inferred or looked up against a prior order.
   */
  hostSystemModel?: string | null;
  /** The customs broker's name/address as they should print on the document. */
  customsBrokerName?: string | null;
  customsBrokerAddress?: string | null;
  /** Country of origin of the goods, as it should print on the document. */
  countryOfOrigin?: string | null;
  /**
   * This proposal's own Section C row list, once customized — see sectionC.ts for the
   * shape and the null-means-"use the live admin template" resolution rule. `null`
   * explicitly un-customizes the proposal back to following the admin template; an
   * empty array is a deliberate "show no Section C rows on this proposal," distinct
   * from null — see resolveSectionCItems's header comment.
   */
  sectionCItems?: SectionCItem[] | null;
  /** Per-proposal replacement for CrossBorderSetting.defaultAcceptanceText. */
  acceptanceTextOverride?: string | null;
  /** Per-proposal replacement for CrossBorderSetting.defaultAuditLanguageText. */
  auditLanguageOverride?: string | null;
  /** Per-proposal replacement for CrossBorderSetting.defaultSectionBSubtext. */
  sectionBSubtextOverride?: string | null;
  /** Font size (points) for sectionBSubtextOverride — travels with it, see the schema
   *  field's comment. Clamped 7-12 by the route before it reaches this function. */
  sectionBSubtextSizePtOverride?: number | null;
}

const AMOUNT_FIELDS = [
  'dutyMinor',
  'surtaxMinor',
  'simaMinor',
  'otherDutyMinor',
  'importTaxMinor',
  'brokerFeeMinor',
] as const;

/**
 * A frozen calculation is history. Editing the customs figures behind a released or
 * accepted proposal would silently restate a document the customer is holding, so it
 * is refused rather than allowed with a warning.
 */
async function assertNotFrozen(versionId: string): Promise<void> {
  const snapshot = await prisma.proposalCrossBorderSnapshot.findFirst({
    where: { versionId, frozen: true },
    select: { id: true },
  });
  if (snapshot) {
    throw new ValidationError(
      'This proposal has been released or accepted. Start a new version to change the customs figures.',
    );
  }
}

/** The entry for a version, creating the unreviewed default if none exists yet. */
export async function customsEntryFor(versionId: string): Promise<ProposalCustomsEntry> {
  const existing = await prisma.proposalCustomsEntry.findUnique({ where: { versionId } });
  if (existing) return existing;

  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { proposalId: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');

  const settings = await prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } });

  return prisma.proposalCustomsEntry.create({
    data: {
      proposalId: version.proposalId,
      versionId,
      // Everything null, status REQUIRES_CUSTOMS_REVIEW by column default. The row
      // exists so the importer-of-record default (and the two newer default postures
      // below) are recorded against this version rather than read from settings that
      // may change later.
      importerOfRecord: settings?.defaultImporterOfRecord ?? 'CUSTOMER',
      gstHstTreatment: settings?.defaultGstHstTreatment ?? null,
      tariff9979Claimed: settings?.defaultTariff9979Claimed ?? null,
      customsBrokerName: settings?.defaultCustomsBrokerName ?? null,
      customsBrokerAddress: settings?.defaultCustomsBrokerAddress ?? null,
      countryOfOrigin: settings?.defaultCountryOfOrigin ?? null,
      // sectionCItems, acceptanceTextOverride and auditLanguageOverride are left null
      // (the column default) on purpose, not seeded from a settings snapshot: unlike
      // the postures above, these are meant to keep tracking the LIVE admin template/
      // default text for as long as nobody customizes this specific proposal — see
      // sectionC.ts and CrossBorderState's acceptanceText/auditLanguageText resolution.
    },
  });
}

/**
 * Save entered figures.
 *
 * Moves REQUIRES_CUSTOMS_REVIEW → ESTIMATED as soon as any amount is present. A
 * CONFIRMED entry drops back to ESTIMATED when a figure changes: an approval applies
 * to the numbers that were approved, not to the field.
 */
export async function saveCustomsEntry(
  versionId: string,
  patch: CustomsEntryPatch,
  actorId: string,
): Promise<ProposalCustomsEntry> {
  await assertNotFrozen(versionId);
  const before = await customsEntryFor(versionId);

  for (const field of AMOUNT_FIELDS) {
    const v = patch[field];
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 0) {
      throw new ValidationError(`${field} must be a whole number of cents, or blank.`);
    }
  }

  // Percentages are thousandths of a percent — 13% is 13000, Quebec's 9.975% is 9975.
  // Bounded rather than merely non-negative: a mistyped rate on a customer document is
  // worse than a refused save, and nothing here is legitimately over 100%.
  for (const field of ['taxPercentMilli', 'tariffPercentMilli'] as const) {
    const v = (patch as Record<string, unknown>)[field];
    if (v == null) continue;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100000) {
      throw new ValidationError(
        `${field === 'taxPercentMilli' ? 'The tax rate' : 'The tariff rate'} must be between 0 and 100 percent.`,
      );
    }
  }

  const merged = { ...before, ...patch };
  const anyAmount =
    AMOUNT_FIELDS.some((f) => merged[f] != null) ||
    // In simple mode a rate IS an entered figure: a proposal quoting 13% tax and no
    // typed amounts is answered, and leaving it at "requires review" would block it.
    (merged as Record<string, unknown>).taxPercentMilli != null ||
    (merged as Record<string, unknown>).tariffPercentMilli != null;

  // A changed figure invalidates an existing approval. Comparing only the amount
  // fields on purpose: a note or a quote reference does not.
  const amountsChanged = AMOUNT_FIELDS.some(
    (f) => patch[f] !== undefined && patch[f] !== before[f],
  );

  let status = before.status;
  if (amountsChanged && before.status === 'CONFIRMED') status = 'ESTIMATED';
  else if (anyAmount && before.status === 'REQUIRES_CUSTOMS_REVIEW') status = 'ESTIMATED';

  // A nullable Json column needs Prisma's DbNull sentinel to clear it to SQL NULL —
  // a plain JS `null` spread into `data` is ambiguous between "set to NULL" and "set
  // to the JSON value null" and Prisma refuses it. Normalizing here also means
  // whatever the route accepted is stored in the same well-formed, order-sorted shape
  // the resolver expects back out.
  const { sectionCItems, ...restPatch } = patch;
  const sectionCItemsData =
    sectionCItems === undefined
      ? {}
      : sectionCItems === null
        ? { sectionCItems: Prisma.DbNull }
        : {
            sectionCItems: normalizeSectionCItems(
              sectionCItems,
            ) as unknown as Prisma.InputJsonValue,
          };

  const updated = await prisma.proposalCustomsEntry.update({
    where: { versionId },
    data: {
      ...restPatch,
      ...sectionCItemsData,
      status,
      enteredById: actorId,
      enteredAt: new Date(),
      // An approval that no longer applies is cleared, not left to imply someone
      // vouched for the new number.
      ...(status !== 'CONFIRMED' && before.status === 'CONFIRMED'
        ? { approvedById: null, approvedAt: null }
        : {}),
    },
  });

  await recordAudit({
    actorId,
    action: 'crossborder.customs.save',
    entity: 'ProposalCustomsEntry',
    entityId: updated.id,
    details: {
      versionId,
      statusFrom: before.status,
      statusTo: updated.status,
      changed: Object.fromEntries(
        (Object.keys(patch) as Array<keyof CustomsEntryPatch>)
          .filter((k) => {
            // sectionCItems is an array: patch[k] !== before[k] is always true by
            // reference, which would log every save as "changed" even when nothing
            // moved. Compared by value instead, against what was actually written
            // (updated), not the raw, un-normalized patch input.
            if (k === 'sectionCItems') {
              return (
                JSON.stringify(before.sectionCItems ?? null) !==
                JSON.stringify(updated.sectionCItems ?? null)
              );
            }
            return patch[k] !== before[k as keyof ProposalCustomsEntry];
          })
          .map((k) => [
            k,
            k === 'sectionCItems'
              ? { from: before.sectionCItems ?? null, to: updated.sectionCItems ?? null }
              : { from: before[k as keyof ProposalCustomsEntry] ?? null, to: patch[k] ?? null },
          ]),
      ),
    },
  });

  return updated;
}

/**
 * Approve the entry.
 *
 * Requires at least one figure. Approving a wholly empty entry would assert that no
 * duty, no tariff and no brokerage arise — which may be true, but it has to be
 * stated deliberately, and `markNotApplicable` is how that is said.
 */
export async function approveCustomsEntry(
  versionId: string,
  actorId: string,
  reason: string | null,
): Promise<ProposalCustomsEntry> {
  await assertNotFrozen(versionId);
  const before = await customsEntryFor(versionId);

  const anyAmount = AMOUNT_FIELDS.some((f) => before[f] != null);
  if (!anyAmount) {
    throw new ValidationError(
      'Enter at least one customs figure before approving, or mark the proposal as having no customs charges.',
    );
  }
  if (!before.sourceReference?.trim()) {
    // Approving a figure whose origin is not recorded leaves nothing to check it
    // against later, which is the state this whole module exists to avoid.
    throw new ValidationError(
      'Record where these figures came from — a broker quote reference, ruling, or prior entry — before approving.',
    );
  }

  const updated = await prisma.proposalCustomsEntry.update({
    where: { versionId },
    data: {
      status: 'CONFIRMED',
      approvedById: actorId,
      approvedAt: new Date(),
      reason: reason?.trim() || null,
    },
  });

  await recordAudit({
    actorId,
    action: 'crossborder.customs.approve',
    entity: 'ProposalCustomsEntry',
    entityId: updated.id,
    details: {
      versionId,
      sourceReference: updated.sourceReference,
      reason: reason?.trim() ?? null,
      amounts: Object.fromEntries(AMOUNT_FIELDS.map((f) => [f, updated[f]])),
    },
  });

  return updated;
}

/**
 * Declare that no customs charges arise — the proposal does not cross the border, or
 * the goods ship from within Canada.
 *
 * A separate act from approving, and audited separately, because it is a different
 * claim: "there is nothing to charge" rather than "these are the charges".
 */
export async function markNoCustomsCharges(
  versionId: string,
  actorId: string,
  reason: string,
): Promise<ProposalCustomsEntry> {
  await assertNotFrozen(versionId);
  if (!reason.trim()) {
    throw new ValidationError('Say why no customs charges apply.');
  }
  const before = await customsEntryFor(versionId);

  const updated = await prisma.proposalCustomsEntry.update({
    where: { versionId },
    data: {
      status: 'NOT_APPLICABLE',
      approvedById: actorId,
      approvedAt: new Date(),
      reason: reason.trim(),
    },
  });

  await recordAudit({
    actorId,
    action: 'crossborder.customs.not_applicable',
    entity: 'ProposalCustomsEntry',
    entityId: updated.id,
    details: { versionId, statusFrom: before.status, reason: reason.trim() },
  });

  return updated;
}

/** Send an approved entry back for review. */
export async function reopenCustomsEntry(
  versionId: string,
  actorId: string,
  reason: string,
): Promise<ProposalCustomsEntry> {
  await assertNotFrozen(versionId);
  if (!reason.trim()) throw new ValidationError('Say why this is going back for review.');
  const before = await customsEntryFor(versionId);

  const updated = await prisma.proposalCustomsEntry.update({
    where: { versionId },
    data: {
      status: 'REQUIRES_CUSTOMS_REVIEW',
      approvedById: null,
      approvedAt: null,
      reason: reason.trim(),
    },
  });

  await recordAudit({
    actorId,
    action: 'crossborder.customs.reopen',
    entity: 'ProposalCustomsEntry',
    entityId: updated.id,
    details: { versionId, statusFrom: before.status, reason: reason.trim() },
  });

  return updated;
}

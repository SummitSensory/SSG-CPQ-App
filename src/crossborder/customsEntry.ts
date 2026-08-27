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
import type { ProposalCustomsEntry } from '@prisma/client';

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
      // exists so the importer-of-record default is recorded against this version
      // rather than read from settings that may change later.
      importerOfRecord: settings?.defaultImporterOfRecord ?? 'CUSTOMER',
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

  const updated = await prisma.proposalCustomsEntry.update({
    where: { versionId },
    data: {
      ...patch,
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
          .filter((k) => patch[k] !== before[k as keyof ProposalCustomsEntry])
          .map((k) => [
            k,
            { from: before[k as keyof ProposalCustomsEntry] ?? null, to: patch[k] ?? null },
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

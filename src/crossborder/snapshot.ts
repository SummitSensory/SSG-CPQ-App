/**
 * The Canadian calculation for one proposal version: assemble it, and freeze it.
 *
 * Everything the pure modules need arrives here from the database, and everything
 * they produce is written back as one JSON snapshot on the version. That snapshot is
 * the reason a proposal issued in March still shows March's figures in August:
 * refreshing a tax table, correcting a broker schedule or a change in the day's
 * exchange rate cannot restate a document a customer is already holding.
 *
 * The rules about writing:
 *
 *   - A FROZEN snapshot is never updated. Not corrected, not recalculated. A
 *     revision creates a new version, and a new version gets its own snapshot.
 *   - An unfrozen snapshot is replaced wholesale on each recalculation, so a draft
 *     always reflects the current proposal.
 *   - Freezing happens on release and on acceptance. After that the row is history.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { versionTotals } from '../proposals/analytics.js';
import { resolveJurisdiction, type Jurisdiction } from './jurisdiction.js';
import { resolveRateForDate, type FxFallbackModeValue } from './rateService.js';
import { buildChargeLines, type CustomsEntryInput, type PipelineResult } from './chargeLines.js';
import { buildSimpleChargeLines } from './simpleCharges.js';
import type {
  CanadianTaxType,
  ChargeCategory,
  TaxabilityRule,
  TaxExemption,
  TaxRateRule,
  TaxRegistration,
  TaxResponsibility,
} from './tax.js';
import type { ProvinceCode } from '../lib/country.js';

/** YYYY-MM-DD from a DATE column, in UTC. Rate and rule dates are calendar dates. */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Decimal(7,4) renders as "13.0000". Harmless in arithmetic — applyPercent reads
 * the scale — but it would print as "13.0000%" on a customer's proposal, so the
 * trailing zeros come off once, here, rather than in every template.
 */
export function normalizePercent(v: unknown): string {
  const s = String(v);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export interface CrossBorderState {
  applicable: boolean;
  jurisdiction: Jurisdiction;
  fx: {
    pair: string;
    rate: string | null;
    observationDate: string | null;
    /**
     * When the rate was actually read, as an ISO instant.
     *
     * Distinct from observationDate, which is the day the Bank of Canada published
     * for. A customer signing against "1 USD = 1.3842 CAD" is entitled to both: over a
     * weekend the two are three days apart, and that gap is their exposure.
     */
    retrievedAt: string | null;
    source: string | null;
    forDate: string;
    stale: boolean;
    fallbackUsed: boolean;
    warning: string | null;
    overrideReason: string | null;
  };
  result: PipelineResult | null;
  /** Everything a human has to resolve before this can be released. */
  blockers: string[];
}

/**
 * The date a version's exchange rate is resolved for.
 *
 * Released (or accepted) versions are frozen on their release date: the CAD figures a
 * customer received must not move. A draft has no such obligation and no such date
 * that means anything — it is quoted whenever someone next looks at it — so it takes
 * the current UTC date. The resolution cache is keyed on this date, so a draft still
 * calls the Bank of Canada at most once a day.
 */
function rateAsOfFor(version: { releasedAt: Date | null }): string {
  return version.releasedAt ? isoDate(version.releasedAt) : isoDate(new Date());
}

/**
 * Assemble the Canadian calculation for a version WITHOUT writing anything.
 *
 * Used for the builder's live view and for the PDF preview. Deterministic for a
 * fixed set of inputs, so calling it twice on an unchanged proposal gives the same
 * answer — which is what makes the written snapshot meaningful.
 */

export async function crossBorderStateFor(versionId: string): Promise<CrossBorderState> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      items: true,
      sections: true,
      createdAt: true,
      releasedAt: true,
      proposalId: true,
      proposal: { select: { organizationId: true } },
    },
  });
  if (!version?.proposal) throw new NotFoundError('Proposal version not found');

  const settings = await prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } });

  // The BILLING address drives this, by business decision — see jurisdiction.ts
  // for what that costs and where to change it.
  const billing = await prisma.address.findFirst({
    where: { organizationId: version.proposal.organizationId, type: 'BILLING' },
    // Address carries no createdAt. id is a cuid, so this is a stable tie-break
    // when an organization holds more than one billing address rather than a
    // meaningful ordering.
    orderBy: { id: 'asc' },
    select: { line1: true, city: true, region: true, postalCode: true, country: true },
  });

  const jurisdiction = resolveJurisdiction(billing);

  const emptyFx = {
    pair: 'USD/CAD',
    rate: null,
    observationDate: null,
    retrievedAt: null,
    source: null,
    forDate: rateAsOfFor(version),
    stale: false,
    fallbackUsed: false,
    warning: null,
    overrideReason: null,
  };

  // Not Canada, or the feature is off: nothing happens. This is the branch that
  // guarantees no existing US proposal changes because this code exists.
  if (!settings?.enabled || !jurisdiction.isCanadian) {
    return { applicable: false, jurisdiction, fx: emptyFx, result: null, blockers: [] };
  }

  const blockers: string[] = [];
  if (!jurisdiction.complete || !jurisdiction.province) {
    // Without a province there is no tax jurisdiction and nothing to calculate.
    // A draft may still be saved; it simply carries the address problem.
    for (const issue of jurisdiction.issues) blockers.push(`address:${issue}`);
    return { applicable: true, jurisdiction, fx: emptyFx, result: null, blockers };
  }
  const province = jurisdiction.province;

  // The date the rate is quoted for. A released proposal is pinned to its release
  // date, so a draft edited later cannot drift onto a newer rate and the customer's
  // copy keeps the figures it went out with.
  //
  // An unreleased draft is pinned to nothing, because it has been quoted to nobody.
  // Pinning it to the day the draft happened to be started meant a proposal opened on
  // Friday still carried Monday's rate — a rate that was never offered to anyone and
  // will not be honoured. So a draft always resolves today's rate; see rateAsOfFor.
  const asOf = rateAsOfFor(version);

  const rateResolution = await resolveRateForDate(asOf, {
    fallbackMode: (settings.fxFallbackMode as FxFallbackModeValue) ?? 'DRAFT_WITH_REVIEW',
    staleRateDays: settings.staleRateDays ?? 5,
  });

  const fx = {
    pair: 'USD/CAD',
    rate: rateResolution.observation?.rate ?? null,
    observationDate: rateResolution.observation?.observationDate ?? null,
    retrievedAt: rateResolution.observation?.retrievedAt
      ? new Date(rateResolution.observation.retrievedAt).toISOString()
      : null,
    source: rateResolution.observation?.source ?? null,
    forDate: asOf,
    stale: rateResolution.stale,
    fallbackUsed: rateResolution.fallbackUsed,
    warning: rateResolution.warning,
    overrideReason: rateResolution.overrideReason,
  };
  if (rateResolution.blocksFinalization) blockers.push('fx:review_required');

  if (!rateResolution.observation) {
    // No rate at all: USD still stands, there is simply no CAD column.
    return { applicable: true, jurisdiction, fx, result: null, blockers };
  }

  const [rateRows, registrationRows, taxabilityRows, exemptionRows, customsRow] = await Promise.all(
    [
      prisma.canadianTaxRate.findMany({ where: { province } }),
      prisma.canadianTaxRegistration.findMany(),
      prisma.crossBorderTaxabilityRule.findMany(),
      prisma.customerTaxExemption.findMany({
        where: { organizationId: version.proposal.organizationId },
      }),
      prisma.proposalCustomsEntry.findUnique({ where: { versionId } }),
    ],
  );

  const rates: TaxRateRule[] = rateRows.map((r) => ({
    id: r.id,
    province: r.province as ProvinceCode,
    taxType: r.taxType as CanadianTaxType,
    ratePercent: normalizePercent(r.ratePercent),
    effectiveFrom: isoDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? isoDate(r.effectiveTo) : null,
  }));

  const registrations: TaxRegistration[] = registrationRows.map((r) => ({
    taxType: r.taxType as CanadianTaxType,
    province: (r.province as ProvinceCode | null) ?? null,
    status: r.status,
    effectiveFrom: isoDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? isoDate(r.effectiveTo) : null,
  }));

  const taxability: TaxabilityRule[] = taxabilityRows.map((r) => ({
    id: r.id,
    category: r.category as ChargeCategory,
    taxType: r.taxType as CanadianTaxType,
    province: (r.province as ProvinceCode | null) ?? null,
    taxable: r.taxable,
    effectiveFrom: isoDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? isoDate(r.effectiveTo) : null,
  }));

  const exemptions: TaxExemption[] = exemptionRows.map((r) => ({
    taxTypes: r.taxTypes as CanadianTaxType[],
    certificateNumber: r.certificateNumber,
    effectiveFrom: isoDate(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? isoDate(r.effectiveTo) : null,
    // An exemption suppresses nothing until somebody with authority approved it.
    approved: !!r.approvedById && !!r.approvedAt,
  }));

  const customs: CustomsEntryInput = customsRow
    ? {
        status: customsRow.status,
        currency: customsRow.currency === 'USD' ? 'USD' : 'CAD',
        dutyMinor: customsRow.dutyMinor,
        surtaxMinor: customsRow.surtaxMinor,
        simaMinor: customsRow.simaMinor,
        otherDutyMinor: customsRow.otherDutyMinor,
        importTaxMinor: customsRow.importTaxMinor,
        brokerFeeMinor: customsRow.brokerFeeMinor,
        importerOfRecord: customsRow.importerOfRecord,
        includedInSellerTotal: customsRow.includedInSellerTotal,
      }
    : {
        // No row yet. The honest default is "nobody has looked", not "no duty".
        status: 'REQUIRES_CUSTOMS_REVIEW',
        currency: 'CAD',
        dutyMinor: null,
        surtaxMinor: null,
        simaMinor: null,
        otherDutyMinor: null,
        importTaxMinor: null,
        brokerFeeMinor: null,
        importerOfRecord: settings.defaultImporterOfRecord,
        includedInSellerTotal: false,
      };

  const totals = versionTotals(version.items, version.sections);

  /**
   * The existing hand-keyed tax field and the Canadian tax engine must not both
   * apply. A rep who typed a tax amount on a Canadian proposal would otherwise be
   * taxed twice — once by hand, once by the engine — and the second amount looks
   * authoritative because a rule produced it.
   */
  if (totals.tax !== 0) blockers.push('tax:manual_amount_present');

  const freight =
    totals.tpFreight + totals.structureFreight + totals.matsFreight + totals.stdFreight;

  const sellerCharges = [
    { category: 'EQUIPMENT' as ChargeCategory, label: 'Equipment', usdMinor: totals.subtotal },
    ...(totals.discount
      ? [{ category: 'DISCOUNT' as ChargeCategory, label: 'Discount', usdMinor: -totals.discount }]
      : []),
    ...(freight
      ? [{ category: 'FREIGHT' as ChargeCategory, label: 'Freight', usdMinor: freight }]
      : []),
  ];

  /**
   * Simple mode short-circuits the rule engine.
   *
   * The full path below needs registrations, dated province rate rows and a taxability
   * ruling per charge category before it will produce a figure — which is correct, and
   * is why no Canadian proposal can go out today. Simple mode takes the rates from the
   * person doing the quoting instead. Everything downstream is unchanged: the same
   * result shape, the same document, the same clauses about CBSA having the final say.
   */
  if (customsRow?.simpleMode) {
    const simple = buildSimpleChargeLines({
      asOf,
      fx: { rate: rateResolution.observation.rate, observationDate: fx.observationDate as string },
      sellerCharges,
      customs: {
        taxLabel: customsRow.taxLabel,
        taxPercentMilli: customsRow.taxPercentMilli,
        tariffPercentMilli: customsRow.tariffPercentMilli,
        brokerFeeMinor: customsRow.brokerFeeMinor,
        tariffOnFreight: customsRow.tariffOnFreight,
        taxOnDuty: customsRow.taxOnDuty,
        importerOfRecord: customsRow.importerOfRecord,
        includedInSellerTotal: customsRow.includedInSellerTotal,
      },
    });
    for (const issue of simple.issues) blockers.push(`calc:${issue}`);
    return { applicable: true, jurisdiction, fx, result: simple, blockers };
  }

  const result = buildChargeLines({
    province,
    asOf,
    fx: { rate: rateResolution.observation.rate, observationDate: fx.observationDate as string },
    sellerCharges,
    customs,
    taxResponsibility: settings.defaultTaxResponsibility as TaxResponsibility,
    rates,
    taxability,
    registrations,
    exemptions,
  });

  for (const issue of result.issues) blockers.push(`calc:${issue}`);

  return { applicable: true, jurisdiction, fx, result, blockers };
}

/**
 * Persist the calculation for a version.
 *
 * Refuses on a frozen snapshot rather than silently skipping: a caller that thinks
 * it recalculated an issued proposal has a bug, and swallowing that would hide it.
 */
export async function writeCrossBorderSnapshot(
  versionId: string,
  actorId: string,
): Promise<{ snapshotId: string | null; blockers: string[] }> {
  const existing = await prisma.proposalCrossBorderSnapshot.findFirst({
    where: { versionId },
    orderBy: { createdAt: 'desc' },
  });
  if (existing?.frozen) {
    throw new ValidationError(
      'This version has an accepted or released Canadian calculation. Create a new version to change it.',
    );
  }

  const state = await crossBorderStateFor(versionId);
  if (!state.applicable) {
    // Was Canadian, now is not — an address correction, say. Remove the stale
    // draft snapshot so nothing downstream reads a jurisdiction that no longer
    // applies. A frozen one is never touched; the guard above has already run.
    if (existing) {
      await prisma.proposalCrossBorderSnapshot.delete({ where: { id: existing.id } });
    }
    return { snapshotId: null, blockers: [] };
  }

  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { proposalId: true },
  });
  if (!version) throw new NotFoundError('Proposal version not found');

  // The tax engine works in bigint. Prisma writes a Json column with
  // JSON.stringify, which throws on a bigint — so these are converted to numbers
  // explicitly. A JSON round-trip would not have helped: it throws too.
  const taxLines = (state.result?.tax.lines ?? []).map((l) => ({
    taxType: l.taxType,
    label: l.label,
    ratePercent: l.ratePercent,
    taxableBasisUsdMinor: Number(l.taxableBasisUsdMinor),
    taxUsdMinor: Number(l.taxUsdMinor),
    rateRuleId: l.rateRuleId,
    status: l.status,
  }));

  const data = {
    proposalId: version.proposalId,
    versionId,
    jurisdiction: { ...state.jurisdiction },
    fx: { ...state.fx },
    taxLines,
    // Already numbers — chargeLines converts on the way out — but spread into
    // plain objects so nothing class-shaped reaches the JSON column.
    chargeLines: (state.result?.lines ?? []).map((l) => ({ ...l })),
    statuses: {
      blockers: state.blockers,
      readyForCustomer: state.result?.readyForCustomer ?? false,
      taxIssues: state.result?.tax.issues ?? [],
    },
    totalsUsd: {
      payableToSummit: state.result?.payableToSummit.usdMinor ?? null,
      separatelyPayable: state.result?.separatelyPayable.usdMinor ?? null,
      estimatedLandedCost: state.result?.estimatedLandedCost.usdMinor ?? null,
    },
    totalsCad: {
      payableToSummit: state.result?.payableToSummit.cadMinor ?? null,
      separatelyPayable: state.result?.separatelyPayable.cadMinor ?? null,
      estimatedLandedCost: state.result?.estimatedLandedCost.cadMinor ?? null,
    },
    createdById: actorId,
  };

  const snapshot = existing
    ? await prisma.proposalCrossBorderSnapshot.update({ where: { id: existing.id }, data })
    : await prisma.proposalCrossBorderSnapshot.create({ data });

  logger.info(
    { versionId, snapshotId: snapshot.id, blockers: state.blockers.length },
    'cross-border snapshot written',
  );
  return { snapshotId: snapshot.id, blockers: state.blockers };
}

/**
 * Freeze the calculation. Called on release and on acceptance.
 *
 * `acceptanceRate` re-locks the CAD reference amounts to the rate published on or
 * before the acceptance date, which is the business rule: the proposal shows the
 * proposal-date rate, the accepted amount uses the acceptance-date rate. Both are
 * kept — the original is not overwritten, because the customer was shown it.
 */
export async function freezeCrossBorderSnapshot(
  versionId: string,
  actorId: string,
  opts: { acceptanceDate?: string } = {},
): Promise<void> {
  const snapshot = await prisma.proposalCrossBorderSnapshot.findFirst({
    where: { versionId },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot) return; // Not a Canadian proposal. Nothing to freeze.
  if (snapshot.frozen) return; // Already history. Idempotent by design.

  let acceptanceFx: object | undefined;
  if (opts.acceptanceDate) {
    const settings = await prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } });
    const resolved = await resolveRateForDate(opts.acceptanceDate, {
      fallbackMode: (settings?.fxFallbackMode as FxFallbackModeValue) ?? 'DRAFT_WITH_REVIEW',
      staleRateDays: settings?.staleRateDays ?? 5,
    });
    acceptanceFx = {
      pair: 'USD/CAD',
      rate: resolved.observation?.rate ?? null,
      observationDate: resolved.observation?.observationDate ?? null,
      source: resolved.observation?.source ?? null,
      forDate: opts.acceptanceDate,
      fallbackUsed: resolved.fallbackUsed,
      warning: resolved.warning,
    };
  }

  await prisma.proposalCrossBorderSnapshot.update({
    where: { id: snapshot.id },
    data: { frozen: true, ...(acceptanceFx ? { acceptanceFx } : {}) },
  });

  await recordAudit({
    actorId,
    action: 'crossborder.snapshot.freeze',
    entity: 'ProposalCrossBorderSnapshot',
    entityId: snapshot.id,
    details: { versionId, acceptanceDate: opts.acceptanceDate ?? null },
  });
}

/** The snapshot a document should print from. */
export async function readCrossBorderSnapshot(versionId: string) {
  return prisma.proposalCrossBorderSnapshot.findFirst({
    where: { versionId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * A blocker code, in words a rep can act on.
 *
 * The codes are namespaced by where the problem is — `address:`, `fx:`, `tax:`,
 * `customs:`, `calc:` — because the release path filters on that prefix to decide
 * which are optional under the current settings. They are not written for people,
 * so nothing should ever show a raw one: this is the one place that turns them into
 * a sentence, and an unrecognised code falls back to the code itself rather than to
 * silence, so a new blocker is visible the day it is added.
 */
export function describeCrossBorderBlocker(code: string): string {
  const key = String(code ?? '').trim();
  const known: Record<string, string> = {
    'fx:review_required':
      'No exchange rate could be resolved for this date, so the Canadian figures cannot be printed.',
    'tax:manual_amount_present':
      'The proposal carries a manually entered tax amount. Clear it — Canadian tax is calculated from the rate table.',
    'calc:tax_requires_review': 'The tax calculation needs review before this goes out.',
    'calc:customs_requires_review': 'The customs figures need review before this goes out.',
    'calc:broker_fee_unconfirmed': 'The brokerage fee has not been confirmed.',
    'calc:missing_taxability_rule':
      'A charge on this proposal has no taxability rule, so nobody has said whether it is taxed.',
    'calc:missing_tax_rate': 'The destination province has no tax rate in force on this date.',
  };
  if (known[key]) return known[key];

  if (key.startsWith('address:')) {
    return `The ship-to address is incomplete (${key.slice('address:'.length).replace(/_/g, ' ')}), so there is no jurisdiction to tax against.`;
  }
  if (key.startsWith('customs:')) {
    return `Customs entry: ${key.slice('customs:'.length).replace(/_/g, ' ')}.`;
  }
  if (key.startsWith('tax:')) {
    return `Tax: ${key.slice('tax:'.length).replace(/_/g, ' ')}.`;
  }
  if (key.startsWith('calc:')) {
    return `Calculation: ${key.slice('calc:'.length).replace(/_/g, ' ')}.`;
  }
  return key;
}

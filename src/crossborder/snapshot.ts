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
import { resolveSectionCItems, type SectionCItem } from './sectionC.js';
import { resolveSectionBItems, type SectionBItem } from './sectionB.js';

/**
 * Section A's functional-description sentence lives on the first GROUP line's
 * `description` — the same field the builder already lets a rep type into, already
 * printed in Section A (proposal-document.js), and the same "first GROUP is the
 * system" convention `proposalFileName()` already uses client-side. No new field.
 */
function firstGroupDescription(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as Record<string, unknown>;
    if ((l.lineType as string | undefined) !== 'GROUP') continue;
    const desc = typeof l.description === 'string' ? l.description.trim() : '';
    return desc || null;
  }
  return null;
}

/**
 * Whether a Canadian proposal has a real answer everywhere it claims one — a pure
 * function of already-resolved facts, so it can be unit-tested without a database.
 * See computeContentBlockers's one call site (crossBorderStateFor) for what feeds it
 * and requireSectionCCompleteBeforeFinal for how the release check gates it.
 */
export function computeContentBlockers(input: {
  sectionADescription: string | null;
  sectionCItems: SectionCItem[];
  customsBrokerName: string | null;
  countryOfOrigin: string | null;
  tariffClassificationCode: string | null;
  tariff9979Claimed: boolean | null;
  gstHstTreatment: string | null;
}): string[] {
  const blockers: string[] = [];
  if (!input.sectionADescription) {
    blockers.push('content:section_a_description_missing');
  }
  for (const item of input.sectionCItems) {
    if (item.kind === 'TEXT') {
      if (!item.text || !item.text.trim()) blockers.push('content:section_c_text_missing');
      continue;
    }
    // A switch over every SectionCBoundField, not if/else-if, and on purpose: the
    // `default` branch below fails to typecheck if SECTION_C_BOUND_FIELDS ever gains
    // a 9th member without this switch being updated to say, explicitly, whether it
    // gates release — closing the exact gap an if-chain leaves, where a new field
    // would silently ship un-gated because nothing forces anyone back to this file.
    switch (item.boundField) {
      case 'customsBroker':
        if (!input.customsBrokerName) blockers.push('content:section_c_customsBroker_missing');
        break;
      case 'countryOfOrigin':
        if (!input.countryOfOrigin) blockers.push('content:section_c_countryOfOrigin_missing');
        break;
      case 'tariffClassificationCode':
        if (!input.tariffClassificationCode) {
          blockers.push('content:section_c_tariffClassificationCode_missing');
        }
        break;
      case 'tariff9979Claimed':
        if (input.tariff9979Claimed == null) {
          blockers.push('content:section_c_tariff9979Claimed_missing');
        }
        break;
      case 'gstHstTreatment':
        if (input.gstHstTreatment == null)
          blockers.push('content:section_c_gstHstTreatment_missing');
        break;
      case 'importerOfRecord':
      case 'hostSystemModel':
      case 'dutiesEstimate':
        // importerOfRecord always has a default, hostSystemModel's blank is a valid
        // final answer ("new complete system"), and dutiesEstimate is already
        // covered by the existing customs-review gate — explicitly, not by omission.
        break;
      case undefined:
        break;
      default: {
        const exhaustiveCheck: never = item.boundField;
        throw new Error(
          `computeContentBlockers: unhandled Section C bound field ${exhaustiveCheck}`,
        );
      }
    }
  }
  return blockers;
}

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
  /**
   * The customs/tariff classification code, typed in by a person on the customs
   * entry. Never inferred, parsed, or computed — see the header comment on
   * customsEntry.ts. Carried here so the document can print it without a second
   * fetch; null when nobody has entered one yet.
   */
  tariffClassificationCode: string | null;
  /**
   * Whether these goods are entered under tariff item 9979.00.00 (disability-relief),
   * typed in by a person on the customs entry. Never computed or inferred — see the
   * field's comment on ProposalCustomsEntry. null = not yet determined.
   */
  tariff9979Claimed: boolean | null;
  /**
   * A human-entered STATUS about whether medical/assistive-device GST/HST relief is
   * being claimed for this shipment. Distinct from the tax-rate calculation engine.
   * null = not yet determined.
   */
  gstHstTreatment: 'STANDARD_RATE' | 'MEDICAL_DEVICE_RELIEF_CLAIMED' | null;
  /**
   * The Summit system model this proposal's components belong to, when the proposal
   * is for replacement/expansion parts. Typed in by a person, never inferred. Null
   * means either a new complete system, or nobody has recorded it yet.
   */
  hostSystemModel: string | null;
  /** Who this proposal's importer of record is — already existed as data; now carried
   *  here so the document can print it (see ProposalCustomsEntry.importerOfRecord). */
  importerOfRecord: 'CUSTOMER' | 'SUMMIT' | 'THIRD_PARTY' | 'TO_BE_DETERMINED' | null;
  /** The customs broker's name/address as they should print on the document. */
  customsBrokerName: string | null;
  customsBrokerAddress: string | null;
  /** Country of origin of the goods, as it should print on the document. */
  countryOfOrigin: string | null;
  /**
   * This proposal's Section C ("Canadian Import Terms") row list, already resolved —
   * the proposal's own customized list if it has one, otherwise the live admin
   * template — and already order-sorted. See sectionC.ts.
   */
  sectionCItems: SectionCItem[];
  /**
   * Resolved Acceptance-page addendum text: this proposal's own override if set,
   * otherwise the current org default (read live, not frozen). Null/blank means the
   * document prints nothing.
   */
  acceptanceText: string | null;
  /** Resolved tariff/duty-audit clause text — same override-then-live-default rule. */
  auditLanguageText: string | null;
  /**
   * This proposal's Section B ("Delivery and Post-Importation Services") clarifying
   * notes, already resolved and order-sorted — the proposal's own customized list if
   * it has one, otherwise the live admin template. Same shape/resolution rule as
   * sectionCItems, minus the BOUND-row concept. See sectionB.ts.
   */
  sectionBItems: SectionBItem[];
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
    return {
      applicable: false,
      jurisdiction,
      tariffClassificationCode: null,
      tariff9979Claimed: null,
      gstHstTreatment: null,
      hostSystemModel: null,
      importerOfRecord: null,
      customsBrokerName: null,
      customsBrokerAddress: null,
      countryOfOrigin: null,
      sectionCItems: [],
      acceptanceText: null,
      auditLanguageText: null,
      sectionBItems: [],
      fx: emptyFx,
      result: null,
      blockers: [],
    };
  }

  // Fetched once, up front, so every `applicable: true` return below — including the
  // early ones for an incomplete address or a missing FX rate — can carry the
  // tariff classification code (and the newer 9979/GST-HST/host-system fields). It is
  // reused at the Promise.all further down rather than fetched a second time.
  const customsRow = await prisma.proposalCustomsEntry.findUnique({ where: { versionId } });
  const tariffClassificationCode = customsRow?.tariffClassificationCode ?? null;
  const tariff9979Claimed = customsRow?.tariff9979Claimed ?? null;
  const gstHstTreatment = customsRow?.gstHstTreatment ?? null;
  const hostSystemModel = customsRow?.hostSystemModel ?? null;
  // Section C / Section B / acceptance / audit text resolution is shared across
  // every `applicable: true` return below, same reasoning as the block above:
  // computed once here rather than repeated at each return point.
  const sectionCFields = {
    importerOfRecord: customsRow?.importerOfRecord ?? null,
    customsBrokerName: customsRow?.customsBrokerName ?? null,
    customsBrokerAddress: customsRow?.customsBrokerAddress ?? null,
    countryOfOrigin: customsRow?.countryOfOrigin ?? null,
    sectionCItems: resolveSectionCItems(customsRow?.sectionCItems, settings?.sectionCTemplate),
    acceptanceText: customsRow?.acceptanceTextOverride ?? settings?.defaultAcceptanceText ?? null,
    auditLanguageText:
      customsRow?.auditLanguageOverride ?? settings?.defaultAuditLanguageText ?? null,
    sectionBItems: resolveSectionBItems(customsRow?.sectionBItems, settings?.sectionBTemplate),
  };

  // Whether a Canadian proposal must have a real answer everywhere it claims one —
  // Section A's functional-description sentence, and every row currently in the
  // resolved Section C list — before it can be released. Computed unconditionally
  // (independent of jurisdiction/FX resolution succeeding) so it appears in every
  // `applicable: true` return below, gated at release time by
  // requireSectionCCompleteBeforeFinal (src/routes/proposals.ts), same pattern as the
  // existing customs/tax gates. Subtext is deliberately never checked here — it's
  // optional clarifying text, not a fact the document claims to state.
  const contentBlockers = computeContentBlockers({
    sectionADescription: firstGroupDescription(version.items),
    sectionCItems: sectionCFields.sectionCItems,
    customsBrokerName: sectionCFields.customsBrokerName,
    countryOfOrigin: sectionCFields.countryOfOrigin,
    tariffClassificationCode,
    tariff9979Claimed,
    gstHstTreatment,
  });

  const blockers: string[] = [...contentBlockers];
  if (!jurisdiction.complete || !jurisdiction.province) {
    // Without a province there is no tax jurisdiction and nothing to calculate.
    // A draft may still be saved; it simply carries the address problem.
    for (const issue of jurisdiction.issues) blockers.push(`address:${issue}`);
    return {
      applicable: true,
      jurisdiction,
      tariffClassificationCode,
      tariff9979Claimed,
      gstHstTreatment,
      hostSystemModel,
      ...sectionCFields,
      fx: emptyFx,
      result: null,
      blockers,
    };
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
    return {
      applicable: true,
      jurisdiction,
      tariffClassificationCode,
      tariff9979Claimed,
      gstHstTreatment,
      hostSystemModel,
      ...sectionCFields,
      fx,
      result: null,
      blockers,
    };
  }

  const [rateRows, registrationRows, taxabilityRows, exemptionRows] = await Promise.all([
    prisma.canadianTaxRate.findMany({ where: { province } }),
    prisma.canadianTaxRegistration.findMany(),
    prisma.crossBorderTaxabilityRule.findMany(),
    prisma.customerTaxExemption.findMany({
      where: { organizationId: version.proposal.organizationId },
    }),
  ]);

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
    return {
      applicable: true,
      jurisdiction,
      tariffClassificationCode,
      tariff9979Claimed,
      gstHstTreatment,
      hostSystemModel,
      ...sectionCFields,
      fx,
      result: simple,
      blockers,
    };
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

  return {
    applicable: true,
    jurisdiction,
    tariffClassificationCode,
    tariff9979Claimed,
    gstHstTreatment,
    hostSystemModel,
    ...sectionCFields,
    fx,
    result,
    blockers,
  };
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
    'content:section_a_description_missing':
      'Section A has no functional-description sentence yet — add one to the system’s line item.',
    'content:section_c_text_missing':
      'A Section C row has no text yet — fill it in, or remove the row from Canadian Import Terms.',
    'content:section_c_customsBroker_missing':
      'Section C lists a customs broker row, but no broker name has been entered.',
    'content:section_c_countryOfOrigin_missing':
      'Section C lists a country-of-origin row, but none has been entered.',
    'content:section_c_tariffClassificationCode_missing':
      'Section C lists a tariff classification row, but no code has been entered.',
    'content:section_c_tariff9979Claimed_missing':
      'Section C lists a tariff item 9979.00.00 row, but whether it’s claimed hasn’t been decided.',
    'content:section_c_gstHstTreatment_missing':
      'Section C lists a GST/HST row, but its treatment hasn’t been decided.',
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
  if (key.startsWith('content:')) {
    return `Proposal content: ${key.slice('content:'.length).replace(/_/g, ' ')}.`;
  }
  return key;
}

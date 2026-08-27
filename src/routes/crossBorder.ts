import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { recordAudit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { crossBorderStateFor, writeCrossBorderSnapshot } from '../crossborder/snapshot.js';
import {
  approveCustomsEntry,
  customsEntryFor,
  markNoCustomsCharges,
  reopenCustomsEntry,
  saveCustomsEntry,
} from '../crossborder/customsEntry.js';
import { recordRateOverride, deactivateRateOverride } from '../crossborder/rateService.js';
import { estimateBrokerFee, parseTiers, selectSchedule } from '../crossborder/brokerFees.js';
import { BankOfCanadaExchangeRateProvider } from '../crossborder/fx.js';
import { normalizeProvince, type ProvinceCode } from '../lib/country.js';

/**
 * Cross-border (Canadian proposal) routes.
 *
 * Three levels of authority, because three different things are being done:
 *
 *   PROPOSAL_READ        see the calculation. A rep has to know their own Canadian
 *                        job is waiting on a customs review.
 *   FREIGHT_COST_WRITE   enter the broker's figures. Same work, same person, as
 *                        entering a vendor's freight quote.
 *   CROSSBORDER_APPROVE  vouch for them — which is what lets a proposal go out as a
 *                        landed-cost quote. A compliance statement about duty and
 *                        tax, so it never sits with the rep closing the deal.
 *   CROSSBORDER_MANAGE   tax rates, registrations, FX fallback, the feature switch.
 *                        Wrong values here misprice every Canadian job at once.
 */

const Money = z.number().int().min(0).max(1_000_000_000);
const Currency = z.enum(['USD', 'CAD']);

const CustomsPatchSchema = z.object({
  currency: Currency.optional(),
  dutyMinor: Money.nullable().optional(),
  surtaxMinor: Money.nullable().optional(),
  simaMinor: Money.nullable().optional(),
  otherDutyMinor: Money.nullable().optional(),
  importTaxMinor: Money.nullable().optional(),
  brokerFeeMinor: Money.nullable().optional(),
  brokerFeeScheduleId: z.string().trim().max(60).nullable().optional(),
  sourceReference: z.string().trim().max(300).nullable().optional(),
  basis: z.string().trim().max(2000).nullable().optional(),
  importerOfRecord: z.enum(['CUSTOMER', 'SUMMIT', 'THIRD_PARTY', 'TO_BE_DETERMINED']).optional(),
  includedInSellerTotal: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /**
   * Percent entry. The rates arrive as decimal percentages ("13", "9.975") and are
   * stored as thousandths of a percent, so the arithmetic downstream is integer only —
   * a float rate is what makes a total fail to reconcile by a cent.
   */
  simpleMode: z.boolean().optional(),
  taxLabel: z.string().trim().max(60).nullable().optional(),
  taxPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  tariffPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  tariffOnFreight: z.boolean().optional(),
  taxOnDuty: z.boolean().optional(),
});

/** "9.975" -> 9975. Rounded, because three decimal places is the stored precision. */
function toMilli(pct: number | null | undefined): number | null | undefined {
  if (pct === undefined) return undefined;
  if (pct === null) return null;
  return Math.round(pct * 1000);
}

const ReasonSchema = z.object({ reason: z.string().trim().min(5).max(500) });

/** A decimal string for an exchange rate. ExchangeRateObservation is Decimal(12,6). */
const RateString = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/);

const RegistrationSchema = z.object({
  taxType: z.enum(['GST', 'HST', 'PST', 'RST', 'QST']),
  /** Null for the federal GST/HST registration; a province code for the rest. */
  province: z.string().trim().length(2).nullable().optional(),
  registrationNumber: z.string().trim().max(40).nullable().optional(),
  status: z.enum(['REGISTERED', 'NOT_REGISTERED', 'PENDING', 'INACTIVE']),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const SettingsSchema = z.object({
  /**
   * Allow a proposal to quote Canadian charges from typed percentages.
   *
   * The rule engine is the destination; this is the road there. With it on, a proposal
   * can carry an honest estimate today, worded as an estimate, instead of waiting on a
   * registration number and a taxability ruling.
   */
  allowSimpleCanadianCharges: z.boolean().optional(),
  enabled: z.boolean().optional(),
  defaultImporterOfRecord: z
    .enum(['CUSTOMER', 'SUMMIT', 'THIRD_PARTY', 'TO_BE_DETERMINED'])
    .optional(),
  defaultTaxResponsibility: z
    .enum([
      'SELLER_COLLECTS',
      'CUSTOMER_PAYS_AT_IMPORT',
      'SELLER_IS_IMPORTER_OF_RECORD',
      'TAX_EXEMPT',
      'REQUIRES_TAX_REVIEW',
    ])
    .optional(),
  allowCadPayment: z.boolean().optional(),
  fxFallbackMode: z
    .enum(['LAST_CACHED', 'MANUAL_RATE', 'BLOCK_FINALIZATION', 'DRAFT_WITH_REVIEW'])
    .optional(),
  staleRateDays: z.number().int().min(1).max(90).optional(),
  requireCustomsReviewBeforeFinal: z.boolean().optional(),
  requireTaxReviewBeforeFinal: z.boolean().optional(),
  proposalValidityDays: z.number().int().min(1).max(365).optional(),
});

const dateOnly = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** The rows in force on a date, for the one-provincial-tax-per-province checks. */
function sameDateLive<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  rows: T[],
  on: Date,
): T[] {
  return rows.filter((r) => r.effectiveFrom <= on && (r.effectiveTo == null || r.effectiveTo > on));
}

/** 0 to 30 percent, up to four decimals — Quebec's 9.975 needs three. */
const RatePercent = z
  .string()
  .regex(/^\d{1,2}(\.\d{1,4})?$/)
  .refine((v) => Number(v) <= 30, 'A Canadian sales tax rate above 30% is a typo.');

const TaxRateSchema = z.object({
  province: z.string().trim().length(2),
  taxType: z.enum(['GST', 'HST', 'PST', 'RST', 'QST']),
  ratePercent: RatePercent,
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  /**
   * Required, not optional. A rate with no provenance cannot be checked later, and
   * `readiness.unreviewedRateCount` reads this column to find the rows still waiting
   * on an accountant.
   */
  source: z.string().trim().min(4).max(300),
  /** Close the row this one replaces, at this row's start date. */
  supersedePrevious: z.boolean().optional(),
});

const ExemptionSchema = z.object({
  organizationId: z.string().trim().min(1),
  /** GST/HST, PST, RST, QST — a certificate may cover more than one. */
  taxTypes: z.array(z.enum(['GST', 'HST', 'PST', 'RST', 'QST'])).min(1),
  exemptionType: z.string().trim().max(80).nullable().optional(),
  certificateNumber: z.string().trim().max(80).nullable().optional(),
  issuingAuthority: z.string().trim().max(120).nullable().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const TaxabilitySchema = z.object({
  category: z.enum([
    'EQUIPMENT',
    'PARTS',
    'FREIGHT',
    'INSTALLATION',
    'DESIGN',
    'TRAINING',
    'TRAVEL',
    'DISCOUNT',
    'CUSTOMS_DUTY',
    'TARIFF_SURTAX',
    'SIMA',
    'IMPORT_TAX',
    'BROKERAGE',
    'SALES_TAX',
    'OTHER',
  ]),
  taxType: z.enum(['GST', 'HST', 'PST', 'RST', 'QST']),
  /** Null means every province, which is how the seed data is expressed. */
  province: z.string().trim().length(2).nullable().optional(),
  taxable: z.boolean(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  source: z.string().trim().min(4).max(300),
});

/**
 * A GST/HST registration that is in force TODAY.
 *
 * Status alone is not enough: a row that has been closed out, or one dated to start
 * next quarter, would otherwise satisfy the readiness check while the tax engine —
 * which does read the dates — still reports every Canadian proposal as needing a tax
 * review. The gate has to ask the same question the engine asks.
 *
 * effectiveTo is EXCLUSIVE, matching the rate table.
 */
function effectiveFederalRegistration() {
  const today = dateOnly(new Date().toISOString().slice(0, 10));
  // Not `as const` on the array: that yields a readonly tuple, and Prisma's `in`
  // takes a mutable array. A literal-union annotation keeps it assignable to the
  // generated enum type without widening to string[].
  const taxTypes: Array<'GST' | 'HST'> = ['GST', 'HST'];
  return {
    taxType: { in: taxTypes },
    status: 'REGISTERED' as const,
    effectiveFrom: { lte: today },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
  };
}

export function registerCrossBorderRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const enter = { preHandler: requirePermission(Permission.FREIGHT_COST_WRITE) };
  const approve = { preHandler: requirePermission(Permission.CROSSBORDER_APPROVE) };
  const manage = { preHandler: requirePermission(Permission.CROSSBORDER_MANAGE) };
  const propose = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  /* ── Per proposal ─────────────────────────────────────────────────────────── */

  /**
   * The whole Canadian picture for a version: jurisdiction, the rate it is quoted
   * on, every charge line in USD and CAD, the three totals, and what is blocking
   * release. Computed, not read from the snapshot, so the builder stays live.
   *
   * `applicable: false` for a non-Canadian proposal or while the feature is off —
   * the client shows nothing at all in that case.
   */
  app.get('/proposals/versions/:versionId/cross-border', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return crossBorderStateFor(versionId);
  });

  /**
   * Persist the calculation. Refuses on a frozen snapshot: recalculating an issued
   * proposal would restate a document the customer already holds.
   */
  app.post('/proposals/versions/:versionId/cross-border/snapshot', enter, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return writeCrossBorderSnapshot(versionId, req.user!.sub);
  });

  /** The stored snapshot a document prints from, or null. */
  app.get('/proposals/versions/:versionId/cross-border/snapshot', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return prisma.proposalCrossBorderSnapshot.findFirst({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
    });
  });

  /* ── Customs figures ──────────────────────────────────────────────────────── */

  /** The entry for this version, created in its unreviewed state if absent. */
  app.get('/proposals/versions/:versionId/customs', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    return customsEntryFor(versionId);
  });

  /**
   * Save what the broker quoted. Moves the entry to ESTIMATED, and drops a
   * CONFIRMED entry back to ESTIMATED if a figure changed — an approval covers the
   * numbers that were approved, not the field.
   */
  app.patch('/proposals/versions/:versionId/customs', enter, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const parsed = CustomsPatchSchema.parse(req.body ?? {});
    const { taxPercent, tariffPercent, ...rest } = parsed;
    return saveCustomsEntry(
      versionId,
      {
        ...rest,
        ...(taxPercent === undefined ? {} : { taxPercentMilli: toMilli(taxPercent) }),
        ...(tariffPercent === undefined ? {} : { tariffPercentMilli: toMilli(tariffPercent) }),
      } as Parameters<typeof saveCustomsEntry>[1],
      req.user!.sub,
    );
  });

  /** Vouch for the figures. Requires a source reference — see customsEntry.ts. */
  app.post('/proposals/versions/:versionId/customs/approve', approve, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return approveCustomsEntry(versionId, req.user!.sub, body.reason ?? null);
  });

  /** Declare that no customs charges arise, with a reason. A different claim. */
  app.post('/proposals/versions/:versionId/customs/not-applicable', approve, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const { reason } = ReasonSchema.parse(req.body ?? {});
    return markNoCustomsCharges(versionId, req.user!.sub, reason);
  });

  /** Send an approved entry back for review. */
  app.post('/proposals/versions/:versionId/customs/reopen', approve, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const { reason } = ReasonSchema.parse(req.body ?? {});
    return reopenCustomsEntry(versionId, req.user!.sub, reason);
  });

  /* ── "Canadian Customer" ────────────────────────────────────────────────────
   *
   * One switch on the proposal builder, and everything a Canadian job needs follows
   * from it. It exists because the alternative was a rep discovering, from an empty
   * screen, that four separate things had to be set by an administrator before a
   * Canadian proposal would price at all: the customer's billing country, the
   * company-wide feature switch, permission to quote from typed percentages, and the
   * per-proposal percent entry.
   *
   * PROPOSAL_WRITE, not CROSSBORDER_MANAGE. That is a deliberate widening, and it is
   * bounded: this route may turn the feature ON and permit percent entry, and it may
   * seed one province's rate onto ONE proposal. It cannot write a tax registration, a
   * dated rate row, an FX override or a broker schedule — the values that would
   * misprice every Canadian job at once still need an administrator.
   *
   * Turning it off does not turn the feature off company-wide: another proposal may
   * be relying on it. It clears this proposal's Canadian figures and puts the
   * customer's billing country back to US, which is what makes the charges disappear.
   */

  /**
   * The standard combined rate per province, as a starting point the quoter edits.
   *
   * Seeded, not authoritative: these are typed onto the proposal as Summit's own
   * estimate, the document says so, and simple mode exists precisely because the
   * registrations and rulings that WOULD be authoritative are not in place. Kept here
   * rather than in the client so the figure that lands in the database and the figure
   * shown to the customer come from one place.
   */
  const PROVINCE_TAX: Record<string, { label: string; percent: number }> = {
    AB: { label: 'GST', percent: 5 },
    BC: { label: 'GST + PST', percent: 12 },
    MB: { label: 'GST + PST', percent: 12 },
    NB: { label: 'HST', percent: 15 },
    NL: { label: 'HST', percent: 15 },
    NS: { label: 'HST', percent: 14 },
    NT: { label: 'GST', percent: 5 },
    NU: { label: 'GST', percent: 5 },
    ON: { label: 'HST', percent: 13 },
    PE: { label: 'HST', percent: 15 },
    QC: { label: 'GST + QST', percent: 14.975 },
    SK: { label: 'GST + PST', percent: 11 },
    YT: { label: 'GST', percent: 5 },
  };

  /** What the switch would do, and what it needs, before it is thrown. */
  app.get('/proposals/versions/:versionId/canadian-customer', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { proposal: { select: { organizationId: true } } },
    });
    if (!version?.proposal) throw new NotFoundError('Proposal version not found');

    const [billing, entry, settings] = await Promise.all([
      prisma.address.findFirst({
        where: { organizationId: version.proposal.organizationId, type: 'BILLING' },
        orderBy: { id: 'asc' },
      }),
      prisma.proposalCustomsEntry.findUnique({ where: { versionId } }),
      prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } }),
    ]);

    const country = String(billing?.country ?? '').toUpperCase();
    const province = billing ? normalizeProvince(billing.region ?? '') : null;
    return {
      canadian: country === 'CA',
      featureEnabled: !!settings?.enabled,
      simpleMode: !!entry?.simpleMode,
      billing: billing
        ? {
            line1: billing.line1,
            line2: billing.line2,
            city: billing.city,
            region: billing.region,
            postalCode: billing.postalCode,
            country,
          }
        : null,
      province,
      suggested: province ? (PROVINCE_TAX[province] ?? null) : null,
      taxLabel: entry?.taxLabel ?? null,
      taxPercent: entry?.taxPercentMilli == null ? null : entry.taxPercentMilli / 1000,
      provinceRates: PROVINCE_TAX,
    };
  });

  const CanadianCustomerSchema = z.object({
    canadian: z.boolean(),
    /** Required when switching on: the engine reads a province, never a city name. */
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).nullish(),
        city: z.string().trim().min(1).max(120),
        region: z.string().trim().min(1).max(120),
        postalCode: z.string().trim().min(1).max(20),
      })
      .optional(),
    taxLabel: z.string().trim().max(60).nullish(),
    taxPercent: z.coerce.number().min(0).max(100).nullish(),
    tariffPercent: z.coerce.number().min(0).max(100).nullish(),
    brokerFeeMinor: Money.nullish(),
  });

  app.post('/proposals/versions/:versionId/canadian-customer', propose, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = CanadianCustomerSchema.parse(req.body ?? {});
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { proposal: { select: { id: true, organizationId: true } } },
    });
    if (!version?.proposal) throw new NotFoundError('Proposal version not found');
    const organizationId = version.proposal.organizationId;

    const existing = await prisma.address.findFirst({
      where: { organizationId, type: 'BILLING' },
      orderBy: { id: 'asc' },
    });

    if (!body.canadian) {
      // Off. The customer goes back to US and this proposal's Canadian figures are
      // cleared; the company-wide switch is left alone because other proposals use it.
      if (existing && String(existing.country).toUpperCase() === 'CA') {
        await prisma.address.update({ where: { id: existing.id }, data: { country: 'US' } });
      }
      await saveCustomsEntry(
        versionId,
        {
          simpleMode: false,
          taxLabel: null,
          taxPercentMilli: null,
          tariffPercentMilli: null,
          brokerFeeMinor: null,
        },
        req.user!.sub,
      );
      await recordAudit({
        actorId: req.user!.sub,
        action: 'crossborder.canadian_customer.off',
        entity: 'ProposalVersion',
        entityId: versionId,
        details: { organizationId },
      });
      return { canadian: false };
    }

    // On. The province has to resolve to a code, because a province is the tax
    // jurisdiction — 'Alberta' typed as 'Albera' would otherwise price as no tax at all.
    const source = body.address ?? {
      line1: existing?.line1 ?? '',
      line2: existing?.line2 ?? null,
      city: existing?.city ?? '',
      region: existing?.region ?? '',
      postalCode: existing?.postalCode ?? '',
    };
    if (!source.line1 || !source.city || !source.region || !source.postalCode) {
      throw new ValidationError(
        'A Canadian customer needs a billing street, city, province and postal code.',
      );
    }
    const province = normalizeProvince(source.region);
    if (!province) {
      throw new ValidationError(
        `"${source.region}" was not recognized as a Canadian province or territory.`,
      );
    }

    const data = {
      line1: source.line1,
      line2: source.line2?.trim() || null,
      city: source.city,
      region: province as ProvinceCode,
      postalCode: source.postalCode,
      country: 'CA',
    };
    const address = existing
      ? await prisma.address.update({ where: { id: existing.id }, data })
      : await prisma.address.create({ data: { ...data, organizationId, type: 'BILLING' } });

    // The company-wide switch, and permission to quote from typed percentages. Both
    // are no-ops when they are already on, which is the usual case after the first
    // Canadian job.
    const settingsBefore = await prisma.crossBorderSetting.findUnique({
      where: { id: 'singleton' },
    });
    const settings = await prisma.crossBorderSetting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', enabled: true, allowSimpleCanadianCharges: true },
      update: { enabled: true, allowSimpleCanadianCharges: true },
    });

    const suggested = PROVINCE_TAX[province];
    const entry = await saveCustomsEntry(
      versionId,
      {
        simpleMode: true,
        taxLabel: (body.taxLabel ?? suggested?.label) || null,
        taxPercentMilli:
          body.taxPercent != null
            ? Math.round(body.taxPercent * 1000)
            : suggested
              ? Math.round(suggested.percent * 1000)
              : null,
        ...(body.tariffPercent != null
          ? { tariffPercentMilli: Math.round(body.tariffPercent * 1000) }
          : {}),
        ...(body.brokerFeeMinor != null ? { brokerFeeMinor: body.brokerFeeMinor } : {}),
      },
      req.user!.sub,
    );

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.canadian_customer.on',
      entity: 'ProposalVersion',
      entityId: versionId,
      details: {
        organizationId,
        addressId: address.id,
        province,
        taxLabel: entry.taxLabel,
        taxPercentMilli: entry.taxPercentMilli,
        featureWasEnabled: !!settingsBefore?.enabled,
        simpleWasAllowed: !!settingsBefore?.allowSimpleCanadianCharges,
      },
    });

    return {
      canadian: true,
      province,
      taxLabel: entry.taxLabel,
      taxPercent: entry.taxPercentMilli == null ? null : entry.taxPercentMilli / 1000,
      enabledFeature: !settingsBefore?.enabled,
      allowedSimple: !settingsBefore?.allowSimpleCanadianCharges,
      featureEnabled: settings.enabled,
    };
  });
  /* ── Administration ───────────────────────────────────────────────────────── */

  /**
   * Settings, plus the two readiness facts an administrator needs before switching
   * the feature on: whether a GST/HST registration exists at all, and how stale the
   * rate table's review is.
   */
  app.get('/cross-border/settings', manage, async () => {
    const [settings, federal, provincial, rateCount, unreviewed] = await Promise.all([
      prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } }),
      prisma.canadianTaxRegistration.findFirst({ where: effectiveFederalRegistration() }),
      prisma.canadianTaxRegistration.findMany({
        where: { taxType: { in: ['PST', 'RST', 'QST'] as Array<'PST' | 'RST' | 'QST'> } },
        orderBy: [{ province: 'asc' }, { effectiveFrom: 'desc' }],
      }),
      prisma.canadianTaxRate.count(),
      prisma.canadianTaxRate.count({ where: { source: { contains: 'CONFIRM' } } }),
    ]);
    return {
      settings,
      readiness: {
        // Without this, every Canadian proposal reports REQUIRES_TAX_REVIEW and
        // cannot be released — which is the correct state until it is entered.
        federalRegistration: federal,
        provincialRegistrations: provincial,
        rateCount,
        unreviewedRateCount: unreviewed,
      },
    };
  });

  app.patch('/cross-border/settings', manage, async (req) => {
    const patch = SettingsSchema.parse(req.body ?? {});

    // Turning the feature on with no GST/HST registration would put every Canadian
    // proposal into tax review the moment it is switched. Better to say so here than
    // to let it be discovered one proposal at a time.
    // The registration gate applies to the RULE ENGINE, which cannot decide what tax
    // to charge without knowing what Summit is registered for. It does not apply to
    // percent entry, where a person states the rate and the document says a person
    // stated it — so requiring the registration there would block the interim path for
    // the sake of a rule nothing is going to consult.
    if (patch.enabled === true && patch.allowSimpleCanadianCharges !== true) {
      const [federal, current] = await Promise.all([
        prisma.canadianTaxRegistration.findFirst({ where: effectiveFederalRegistration() }),
        prisma.crossBorderSetting.findUnique({ where: { id: 'singleton' } }),
      ]);
      const simpleAllowed = patch.allowSimpleCanadianCharges ?? current?.allowSimpleCanadianCharges;
      if (!federal && !simpleAllowed) {
        throw new ValidationError(
          "Enter Summit's GST/HST registration before enabling Canadian proposals, or turn on percent entry — " +
            'without one of the two, every Canadian proposal reports a tax review and cannot be released.',
        );
      }
    }

    const updated = await prisma.crossBorderSetting.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...patch, updatedById: req.user!.sub },
      update: { ...patch, updatedById: req.user!.sub },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.settings.update',
      entity: 'CrossBorderSetting',
      entityId: updated.id,
      details: { changed: patch },
    });
    return updated;
  });

  /**
   * Tax rates, for the admin table.
   *
   * Writable. The original design said corrections go by migration, and for a
   * SEEDED rate that is still the better route — a wrong rate misprices every
   * Canadian job at once and should leave a commit behind. But a province with NO
   * row at all is a different situation: the engine returns `no_rate_for_province`,
   * the proposal cannot be released, and waiting on a deploy to enter a rate that is
   * published on the CRA's own site is a deploy nobody should have to wait for.
   *
   * So: entry is allowed, a source is REQUIRED, and every write is audited with the
   * row it replaced.
   */
  app.get('/cross-border/tax-rates', manage, async () => {
    return prisma.canadianTaxRate.findMany({
      orderBy: [{ province: 'asc' }, { taxType: 'asc' }, { effectiveFrom: 'desc' }],
    });
  });

  /**
   * Enter a rate.
   *
   * Two things this refuses, because both produce a wrong number rather than an
   * error:
   *
   *   - **An overlap.** Two rows in force for the same province and tax type on the
   *     same date means the answer depends on row order. `supersedePrevious` is the
   *     sanctioned way through: it closes the open row at the new row's start date,
   *     which is exactly the abutting pair the engine's exclusive `effectiveTo`
   *     expects.
   *   - **A second PST-family rate.** Manitoba is RST, Quebec is QST, and a province
   *     with HST has no separate provincial line at all. Two provincial rates in one
   *     province is not a jurisdiction that exists.
   */
  app.post('/cross-border/tax-rates', manage, async (req) => {
    const body = TaxRateSchema.parse(req.body ?? {});
    const from = dateOnly(body.effectiveFrom);
    const to = body.effectiveTo ? dateOnly(body.effectiveTo) : null;
    if (to && to <= from) {
      throw new ValidationError('The end date must be after the start date. It is exclusive.');
    }

    const siblings = await prisma.canadianTaxRate.findMany({
      where: { province: body.province },
    });

    const sameKind = siblings.filter((r) => r.taxType === body.taxType);
    const overlapping = sameKind.filter(
      (r) =>
        (r.effectiveTo == null || r.effectiveTo > from) && (to == null || r.effectiveFrom < to),
    );

    if (overlapping.length && !body.supersedePrevious) {
      const o = overlapping[0]!;
      throw new ValidationError(
        `${body.province} already has a ${body.taxType} rate of ${o.ratePercent}% in force from ` +
          `${o.effectiveFrom.toISOString().slice(0, 10)}. Supersede it to close that row on ` +
          `${body.effectiveFrom} and start this one, or correct the existing row instead.`,
      );
    }

    // HST replaces the provincial line rather than sitting beside it, so mixing the
    // two in one province would produce a proposal charging both.
    const provincial = ['PST', 'RST', 'QST'];
    const live = sameDateLive(siblings, from);
    if (body.taxType === 'HST' && live.some((r) => provincial.includes(r.taxType))) {
      throw new ValidationError(
        `${body.province} has a provincial sales tax row in force. An HST province has no separate provincial line — close that row first.`,
      );
    }
    if (provincial.includes(body.taxType) && live.some((r) => r.taxType === 'HST')) {
      throw new ValidationError(
        `${body.province} is an HST province on that date. HST is one line and is never split into federal and provincial parts.`,
      );
    }
    if (
      provincial.includes(body.taxType) &&
      live.some((r) => provincial.includes(r.taxType) && r.taxType !== body.taxType)
    ) {
      throw new ValidationError(
        `${body.province} already has a ${live.find((r) => provincial.includes(r.taxType))!.taxType} row in force. A province has one provincial sales tax, not two.`,
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      for (const row of overlapping) {
        // Close, never delete. The old row is what an already-issued proposal was
        // priced on, and its snapshot references it.
        if (row.effectiveFrom >= from) {
          throw new ValidationError(
            `An existing ${body.taxType} row already starts on or after ${body.effectiveFrom}. Correct that row rather than superseding it.`,
          );
        }
        await tx.canadianTaxRate.update({ where: { id: row.id }, data: { effectiveTo: from } });
      }
      return tx.canadianTaxRate.create({
        data: {
          province: body.province,
          taxType: body.taxType,
          ratePercent: body.ratePercent,
          effectiveFrom: from,
          effectiveTo: to,
          source: body.source,
          approvedById: req.user!.sub,
        },
      });
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.taxRate.create',
      entity: 'CanadianTaxRate',
      entityId: created.id,
      details: {
        province: created.province,
        taxType: created.taxType,
        ratePercent: body.ratePercent,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        source: body.source,
        superseded: overlapping.map((r) => ({
          id: r.id,
          ratePercent: String(r.ratePercent),
          closedAt: body.effectiveFrom,
        })),
      },
    });
    return created;
  });

  /**
   * Correct a rate.
   *
   * A correction is for a row entered wrongly. A rate that genuinely CHANGED is a new
   * row with its own effective date — editing the old one in place would restate what
   * every proposal priced on it was quoted.
   */
  app.patch('/cross-border/tax-rates/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const before = await prisma.canadianTaxRate.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Rate not found.');

    const body = TaxRateSchema.partial().parse(req.body ?? {});
    if (!body.source?.trim()) {
      throw new ValidationError('Record where the corrected figure came from.');
    }

    const updated = await prisma.canadianTaxRate.update({
      where: { id },
      data: {
        ...(body.ratePercent ? { ratePercent: body.ratePercent } : {}),
        ...(body.effectiveFrom ? { effectiveFrom: dateOnly(body.effectiveFrom) } : {}),
        ...(body.effectiveTo !== undefined
          ? { effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null }
          : {}),
        source: body.source,
        approvedById: req.user!.sub,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.taxRate.update',
      entity: 'CanadianTaxRate',
      entityId: id,
      details: {
        province: before.province,
        taxType: before.taxType,
        from: {
          ratePercent: String(before.ratePercent),
          effectiveFrom: before.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: before.effectiveTo?.toISOString().slice(0, 10) ?? null,
        },
        to: {
          ratePercent: String(updated.ratePercent),
          effectiveFrom: updated.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: updated.effectiveTo?.toISOString().slice(0, 10) ?? null,
        },
        source: body.source,
      },
    });
    return updated;
  });

  /**
   * Taxability rules — whether a charge category is taxable for a tax type.
   *
   * Here for the same reason the rates are: a rate with no taxability rule charges
   * nothing and blocks the proposal, so entering a rate without being able to enter
   * the rule beside it would be half an answer. `INSTALLATION`, `DESIGN`, `TRAINING`,
   * `TRAVEL` and `OTHER` are the unseeded ones — deliberately, because installation
   * into real property varies by province and needs a ruling, not a guess.
   */
  app.get('/cross-border/taxability', manage, async () => {
    return prisma.crossBorderTaxabilityRule.findMany({
      orderBy: [{ category: 'asc' }, { taxType: 'asc' }, { effectiveFrom: 'desc' }],
    });
  });

  app.post('/cross-border/taxability', manage, async (req) => {
    const body = TaxabilitySchema.parse(req.body ?? {});
    const from = dateOnly(body.effectiveFrom);

    const existing = await prisma.crossBorderTaxabilityRule.findFirst({
      where: {
        category: body.category,
        taxType: body.taxType,
        province: body.province ?? null,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
      },
    });
    if (existing) {
      throw new ValidationError(
        `${body.category} already has a ${body.taxType} rule in force${body.province ? ` in ${body.province}` : ''} — it is ${existing.taxable ? 'taxable' : 'not taxable'} from ${existing.effectiveFrom.toISOString().slice(0, 10)}. Close that rule before entering another.`,
      );
    }

    const created = await prisma.crossBorderTaxabilityRule.create({
      data: {
        category: body.category,
        taxType: body.taxType,
        province: body.province ?? null,
        taxable: body.taxable,
        effectiveFrom: from,
        effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null,
        source: body.source,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.taxability.create',
      entity: 'CrossBorderTaxabilityRule',
      entityId: created.id,
      details: {
        category: created.category,
        taxType: created.taxType,
        province: created.province,
        taxable: created.taxable,
        effectiveFrom: body.effectiveFrom,
        source: body.source,
      },
    });
    return created;
  });

  app.get('/cross-border/tax-registrations', manage, async () => {
    return prisma.canadianTaxRegistration.findMany({
      orderBy: [{ taxType: 'asc' }, { province: 'asc' }, { effectiveFrom: 'desc' }],
    });
  });

  /**
   * Record a registration.
   *
   * GST and HST are ONE federal registration: a single row with a null province
   * covers both in every province. PST, RST and QST are registered province by
   * province and require one.
   */
  app.post('/cross-border/tax-registrations', manage, async (req) => {
    const body = RegistrationSchema.parse(req.body ?? {});
    const federal = body.taxType === 'GST' || body.taxType === 'HST';

    if (!federal && !body.province) {
      throw new ValidationError(`${body.taxType} is registered per province — choose one.`);
    }
    if (federal && body.province) {
      throw new ValidationError(
        'GST/HST is a single federal registration and covers every province. Leave the province blank.',
      );
    }

    const created = await prisma.canadianTaxRegistration.create({
      data: {
        taxType: body.taxType,
        province: federal ? null : (body.province ?? null),
        registrationNumber: body.registrationNumber ?? null,
        status: body.status,
        effectiveFrom: dateOnly(body.effectiveFrom),
        effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null,
        notes: body.notes ?? null,
        approvedById: req.user!.sub,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.registration.create',
      entity: 'CanadianTaxRegistration',
      entityId: created.id,
      details: {
        taxType: created.taxType,
        province: created.province,
        status: created.status,
        effectiveFrom: body.effectiveFrom,
      },
    });
    return created;
  });

  /** Close or correct a registration. */
  app.patch('/cross-border/tax-registrations/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const body = RegistrationSchema.partial().parse(req.body ?? {});
    const before = await prisma.canadianTaxRegistration.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Registration not found.');

    const updated = await prisma.canadianTaxRegistration.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.registrationNumber !== undefined
          ? { registrationNumber: body.registrationNumber }
          : {}),
        ...(body.effectiveFrom ? { effectiveFrom: dateOnly(body.effectiveFrom) } : {}),
        ...(body.effectiveTo !== undefined
          ? { effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.registration.update',
      entity: 'CanadianTaxRegistration',
      entityId: id,
      details: { from: { status: before.status }, to: { status: updated.status } },
    });
    return updated;
  });

  /* ── Exchange rate ────────────────────────────────────────────────────────── */

  /** The observations on file, newest first, for the admin screen. */
  app.get('/cross-border/fx', manage, async () => {
    const [observations, overrides] = await Promise.all([
      prisma.exchangeRateObservation.findMany({
        orderBy: { observationDate: 'desc' },
        take: 30,
      }),
      prisma.exchangeRateOverride.findMany({ orderBy: { effectiveDate: 'desc' }, take: 20 }),
    ]);
    return { observations, overrides };
  });

  /**
   * Fetch today's rate from the Bank of Canada now, and say what happened.
   *
   * Until a Canadian proposal is priced, nothing has ever called the Bank, so the
   * screen reads "no observations fetched yet" — which is indistinguishable from a
   * connection that does not work. This makes the difference visible without having to
   * build a proposal to find out, and the observation it stores is a real one that
   * later proposals reuse.
   */
  app.post('/cross-border/fx/refresh', manage, async () => {
    const asOf = new Date().toISOString().slice(0, 10);
    try {
      const observation = await new BankOfCanadaExchangeRateProvider().observationOnOrBefore(asOf);
      if (!observation) {
        return {
          ok: false,
          message:
            'The Bank of Canada answered, but published no USD/CAD observation in the last 14 days. That is unusual enough to be worth checking their site directly.',
        };
      }
      // The provider speaks calendar dates ('2026-08-26'); the column is a DateTime.
      // Prisma will not widen one into the other, so it is converted here — the same
      // dateOnly() the rest of this file and rateService.persist() use, so a rate
      // stored by the admin button and one stored by pricing land on the same instant
      // and collide on the unique key as they should.
      const observationDate = dateOnly(observation.observationDate);
      await prisma.exchangeRateObservation.upsert({
        where: {
          pair_observationDate: { pair: observation.pair, observationDate },
        },
        create: {
          pair: observation.pair,
          rate: observation.rate,
          observationDate,
          source: 'BANK_OF_CANADA',
          retrievedAt: observation.retrievedAt,
        },
        update: { rate: observation.rate, retrievedAt: observation.retrievedAt },
      });
      return {
        ok: true,
        rate: observation.rate,
        observationDate: observation.observationDate,
        retrievedAt: observation.retrievedAt.toISOString(),
        message: `1 USD = ${observation.rate} CAD, published for ${observation.observationDate}.`,
      };
    } catch (err) {
      // The reason matters: a DNS failure, a blocked egress and a timeout all look the
      // same from the screen, and only the message tells them apart.
      return {
        ok: false,
        message: `Could not reach the Bank of Canada: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  /** A manual rate. Rate, effective date, reason and actor are all mandatory. */
  app.post('/cross-border/fx/override', manage, async (req) => {
    const body = z
      .object({
        rate: RateString,
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().trim().min(5).max(500),
      })
      .parse(req.body ?? {});
    await recordRateOverride({ ...body, actorId: req.user!.sub });
    return { ok: true };
  });

  /** Withdraw a manual rate so the configured fallback stops using it. */
  app.post('/cross-border/fx/override/:id/deactivate', manage, async (req) => {
    const { id } = req.params as { id: string };
    await deactivateRateOverride(id, req.user!.sub);
    return { ok: true };
  });

  /* ── Broker fee schedules ─────────────────────────────────────────────────── */

  /**
   * The schedules on file, plus which one is in force today.
   *
   * Brokerage is the one border charge that is genuinely knowable in advance —
   * it comes off the broker's own published tariff, not off a tariff classification
   * this database does not hold. So it can be computed. It still is not APPLIED
   * automatically: `ProposalCustomsEntry.brokerFeeMinor` stays a person's entry, and
   * this only saves them the arithmetic.
   */
  app.get('/cross-border/broker-fees', manage, async () => {
    const schedules = await prisma.customsBrokerFeeSchedule.findMany({
      orderBy: [{ active: 'desc' }, { effectiveFrom: 'desc' }],
    });
    const inForce = selectSchedule(schedules, dateOnly(new Date().toISOString().slice(0, 10)));
    return { schedules, inForceId: inForce?.id ?? null };
  });

  /**
   * What a schedule would charge on a given entry value, itemized.
   *
   * A preview, on the admin screen and beside the customs form. Nothing is written.
   */
  app.get('/cross-border/broker-fees/:id/estimate', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        valueMinor: z.coerce.number().int().min(0).max(1_000_000_000),
        entryCount: z.coerce.number().int().min(1).max(200).optional(),
        shipmentCount: z.coerce.number().int().min(1).max(200).optional(),
        lineCount: z.coerce.number().int().min(0).max(5000).optional(),
      })
      .parse(req.query ?? {});
    const schedule = await prisma.customsBrokerFeeSchedule.findUnique({ where: { id } });
    if (!schedule) throw new NotFoundError('Fee schedule not found.');
    // `percent` is a Prisma Decimal. The evaluator takes the decimal STRING, so the
    // scale the column round-tripped is the scale the arithmetic uses — going through
    // a JS number here would be the one float in the whole money path.
    return estimateBrokerFee(
      { ...schedule, percent: schedule.percent == null ? null : schedule.percent.toString() },
      q,
    );
  });

  app.post('/cross-border/broker-fees', manage, async (req) => {
    const body = BrokerFeeSchema.parse(req.body ?? {});
    validateSchedule(body);
    const created = await prisma.customsBrokerFeeSchedule.create({
      data: {
        ...scheduleData(body),
        name: body.name,
        feeType: body.feeType,
        effectiveFrom: dateOnly(body.effectiveFrom!),
        reviewedById: req.user!.sub,
        reviewedAt: new Date(),
      },
    });
    if (created.isDefault) await clearOtherDefaults(created.id);

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.brokerFee.create',
      entity: 'CustomsBrokerFeeSchedule',
      entityId: created.id,
      details: { name: created.name, feeType: created.feeType, effectiveFrom: body.effectiveFrom },
    });
    return created;
  });

  app.patch('/cross-border/broker-fees/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const before = await prisma.customsBrokerFeeSchedule.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Fee schedule not found.');

    const body = BrokerFeeSchema.partial().parse(req.body ?? {});
    // Validate the MERGED row, not the patch: switching a flat schedule to a
    // percentage in one field would otherwise pass while leaving no rate on it.
    // Dates are normalized to YYYY-MM-DD first — the stored columns are Dates, and a
    // Date compared against a patched string is a comparison that quietly succeeds.
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    validateSchedule({
      feeType: before.feeType,
      amountMinor: before.amountMinor,
      percent: before.percent == null ? null : String(before.percent),
      minMinor: before.minMinor,
      maxMinor: before.maxMinor,
      tiers: (before.tiers ?? null) as never,
      effectiveFrom: iso(before.effectiveFrom) ?? undefined,
      effectiveTo: iso(before.effectiveTo),
      ...body,
    });

    const updated = await prisma.customsBrokerFeeSchedule.update({
      where: { id },
      data: {
        ...scheduleData(body),
        ...(body.name ? { name: body.name } : {}),
        ...(body.feeType ? { feeType: body.feeType } : {}),
        ...(body.effectiveFrom ? { effectiveFrom: dateOnly(body.effectiveFrom) } : {}),
        reviewedById: req.user!.sub,
        reviewedAt: new Date(),
      },
    });
    if (updated.isDefault) await clearOtherDefaults(updated.id);

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.brokerFee.update',
      entity: 'CustomsBrokerFeeSchedule',
      entityId: id,
      details: { changed: Object.keys(body) },
    });
    return updated;
  });

  /* ── Customer tax exemptions ─────────────────────────────────────────────── */

  /**
   * A customer's exemption certificates.
   *
   * The engine already honours these, and only when `approved` is true. That is the
   * whole reason this screen exists: being a school, a charity or a public body is
   * NOT itself an exemption, and a rebate the customer claims back later is not a
   * point-of-sale exemption either. Somebody has to look at the certificate.
   *
   * Recording and approving are deliberately different permissions. A rep can record
   * the certificate a customer sent; deciding it removes 13% from an invoice is a
   * compliance call.
   */
  app.get('/cross-border/exemptions', manage, async () => {
    const exemptions = await prisma.customerTaxExemption.findMany({
      orderBy: [{ effectiveFrom: 'desc' }],
      take: 200,
    });
    if (exemptions.length === 0) return [];

    const orgs = await prisma.organization.findMany({
      where: { id: { in: [...new Set(exemptions.map((e) => e.organizationId))] } },
      select: { id: true, name: true },
    });
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    return exemptions.map((e) => ({ ...e, customer: name.get(e.organizationId) ?? null }));
  });

  app.post('/cross-border/exemptions', enter, async (req) => {
    const body = ExemptionSchema.parse(req.body ?? {});
    const org = await prisma.organization.findUnique({
      where: { id: body.organizationId },
      select: { id: true },
    });
    if (!org) throw new NotFoundError('Customer not found.');

    const created = await prisma.customerTaxExemption.create({
      data: {
        organizationId: body.organizationId,
        taxTypes: body.taxTypes,
        exemptionType: body.exemptionType ?? null,
        certificateNumber: body.certificateNumber ?? null,
        issuingAuthority: body.issuingAuthority ?? null,
        effectiveFrom: dateOnly(body.effectiveFrom),
        effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null,
        notes: body.notes ?? null,
        createdById: req.user!.sub,
        // Never approved on creation, whoever is calling. Recording a certificate and
        // vouching for it are two acts, and the engine reads only the second.
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.exemption.create',
      entity: 'CustomerTaxExemption',
      entityId: created.id,
      details: {
        organizationId: created.organizationId,
        taxTypes: created.taxTypes,
        certificateNumber: created.certificateNumber,
        effectiveFrom: body.effectiveFrom,
      },
    });
    return created;
  });

  /**
   * Vouch for the certificate.
   *
   * Requires a certificate number and an issuing authority: an approval with neither
   * is a decision nobody can check later, and this one takes tax off an invoice.
   */
  app.post('/cross-border/exemptions/:id/approve', approve, async (req) => {
    const { id } = req.params as { id: string };
    const before = await prisma.customerTaxExemption.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Exemption not found.');
    if (before.approvedById) return before;

    if (!before.certificateNumber?.trim() || !before.issuingAuthority?.trim()) {
      throw new ValidationError(
        'Record the certificate number and who issued it before approving — this suppresses tax on every proposal for this customer.',
      );
    }

    const updated = await prisma.customerTaxExemption.update({
      where: { id },
      data: { approvedById: req.user!.sub, approvedAt: new Date() },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crossborder.exemption.approve',
      entity: 'CustomerTaxExemption',
      entityId: id,
      details: {
        organizationId: updated.organizationId,
        taxTypes: updated.taxTypes,
        certificateNumber: updated.certificateNumber,
        issuingAuthority: updated.issuingAuthority,
      },
    });
    return updated;
  });

  /**
   * Close an exemption, or withdraw its approval.
   *
   * Closing is dated and exclusive, like every other effective-dated row here, so
   * proposals already priced under it keep their figures. Withdrawing the approval is
   * the immediate lever for a certificate that turns out not to hold.
   */
  app.post('/cross-border/exemptions/:id/close', approve, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        effectiveTo: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        withdrawApproval: z.boolean().optional(),
        reason: z.string().trim().min(5).max(500),
      })
      .parse(req.body ?? {});

    const before = await prisma.customerTaxExemption.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Exemption not found.');

    const updated = await prisma.customerTaxExemption.update({
      where: { id },
      data: {
        ...(body.effectiveTo !== undefined
          ? { effectiveTo: body.effectiveTo ? dateOnly(body.effectiveTo) : null }
          : {}),
        ...(body.withdrawApproval ? { approvedById: null, approvedAt: null } : {}),
        notes: [before.notes, body.reason].filter(Boolean).join('\n'),
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: body.withdrawApproval
        ? 'crossborder.exemption.withdraw'
        : 'crossborder.exemption.close',
      entity: 'CustomerTaxExemption',
      entityId: id,
      details: {
        organizationId: before.organizationId,
        effectiveTo: body.effectiveTo ?? null,
        reason: body.reason,
      },
    });
    return updated;
  });

  /* ── Customs review queue ─────────────────────────────────────────────────── */

  /**
   * Every Canadian proposal waiting on a customs decision, oldest first.
   *
   * Without this the queue is invisible: an entry sits at REQUIRES_CUSTOMS_REVIEW on
   * one proposal's screen, and the person who approves customs figures has no list to
   * work from. Read permission rather than approve, so a rep can see their own job is
   * waiting — the approve action is still gated.
   */
  app.get('/cross-border/customs-queue', read, async (req) => {
    const q = z.object({ includeSettled: z.coerce.boolean().optional() }).parse(req.query ?? {});
    const open: Array<'REQUIRES_CUSTOMS_REVIEW' | 'ESTIMATED'> = [
      'REQUIRES_CUSTOMS_REVIEW',
      'ESTIMATED',
    ];

    const entries = await prisma.proposalCustomsEntry.findMany({
      where: q.includeSettled ? {} : { status: { in: open } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    if (entries.length === 0) return [];

    const proposals = await prisma.proposal.findMany({
      where: { id: { in: [...new Set(entries.map((e) => e.proposalId))] } },
      select: { id: true, number: true, title: true, organizationId: true },
    });
    const orgs = await prisma.organization.findMany({
      where: { id: { in: [...new Set(proposals.map((p) => p.organizationId))] } },
      select: { id: true, name: true },
    });
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const byProposal = new Map(proposals.map((p) => [p.id, p]));

    return entries.map((e) => {
      const p = byProposal.get(e.proposalId);
      return {
        ...e,
        proposalNumber: p?.number ?? null,
        proposalTitle: p?.title ?? null,
        customer: p ? (orgName.get(p.organizationId) ?? null) : null,
        // What the entry is missing, so the queue can say why a row is not approvable
        // without the client re-deriving the rule in customsEntry.ts.
        missingSourceReference: !e.sourceReference?.trim(),
        hasAnyAmount:
          e.dutyMinor != null ||
          e.surtaxMinor != null ||
          e.simaMinor != null ||
          e.otherDutyMinor != null ||
          e.importTaxMinor != null ||
          e.brokerFeeMinor != null,
      };
    });
  });
}

/* ── Broker fee schedule validation ─────────────────────────────────────────── */

const TierSchema = z.object({
  upToMinor: z.number().int().min(0).nullable(),
  amountMinor: z.number().int().min(0).nullable().optional(),
  percent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,4})?$/)
    .nullable()
    .optional(),
  label: z.string().trim().max(80).nullable().optional(),
});

const BrokerFeeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  brokerName: z.string().trim().max(120).nullable().optional(),
  feeType: z.enum([
    'FLAT',
    'PERCENTAGE',
    'TIERED',
    'PER_ENTRY',
    'PER_SHIPMENT',
    'PER_LINE',
    'MANUAL',
  ]),
  currency: z.enum(['USD', 'CAD']).optional(),
  amountMinor: Money.nullable().optional(),
  /** A PERCENT, not a fraction: `0.25` is a quarter of one percent. */
  percent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,4})?$/)
    .nullable()
    .optional(),
  minMinor: Money.nullable().optional(),
  maxMinor: Money.nullable().optional(),
  tiers: z.array(TierSchema).max(20).nullable().optional(),
  disbursementMinor: Money.nullable().optional(),
  advancementMinor: Money.nullable().optional(),
  bondMinor: Money.nullable().optional(),
  customerPaysDirectly: z.boolean().optional(),
  includedInSellerTotal: z.boolean().optional(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

type BrokerFeeInput = z.infer<typeof BrokerFeeSchema>;

/**
 * Refuse a schedule that cannot produce a figure.
 *
 * Saving a percentage schedule with no rate is not a harmless draft: it reaches the
 * proposal screen as "this schedule has no rate on it" on a live Canadian job.
 */
function validateSchedule(s: Partial<BrokerFeeInput>): void {
  const needsAmount = ['FLAT', 'PER_ENTRY', 'PER_SHIPMENT', 'PER_LINE'];
  if (s.feeType && needsAmount.includes(s.feeType) && s.amountMinor == null) {
    throw new ValidationError('Enter the fee amount for this schedule.');
  }
  if (s.feeType === 'PERCENTAGE' && !s.percent) {
    throw new ValidationError('Enter the percentage rate for this schedule.');
  }
  if (s.feeType === 'TIERED') {
    if (!parseTiers(s.tiers ?? null)) {
      throw new ValidationError(
        'A tiered schedule needs at least one tier, each with an amount or a rate, and at most one open-ended tier.',
      );
    }
  }
  if (s.minMinor != null && s.maxMinor != null && s.minMinor > s.maxMinor) {
    throw new ValidationError('The minimum fee is above the maximum fee.');
  }
  if (s.effectiveFrom && s.effectiveTo && s.effectiveTo <= s.effectiveFrom) {
    // effectiveTo is EXCLUSIVE, so equal dates describe a schedule that never runs.
    throw new ValidationError('The end date must be after the start date. It is exclusive.');
  }
}

/** Only the fields present in the patch, dates converted. */
function scheduleData(s: Partial<BrokerFeeInput>) {
  return {
    ...(s.brokerName !== undefined ? { brokerName: s.brokerName } : {}),
    ...(s.currency ? { currency: s.currency } : {}),
    ...(s.amountMinor !== undefined ? { amountMinor: s.amountMinor } : {}),
    ...(s.percent !== undefined ? { percent: s.percent } : {}),
    ...(s.minMinor !== undefined ? { minMinor: s.minMinor } : {}),
    ...(s.maxMinor !== undefined ? { maxMinor: s.maxMinor } : {}),
    ...(s.tiers !== undefined
      ? {
          // A Prisma Json column does not take `null` — that is `Prisma.DbNull`, which
          // clears the column, as distinct from `JsonNull`, which stores a JSON null.
          // Clearing is what "this schedule has no tier table" means.
          tiers: s.tiers ? (s.tiers as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        }
      : {}),
    ...(s.disbursementMinor !== undefined ? { disbursementMinor: s.disbursementMinor } : {}),
    ...(s.advancementMinor !== undefined ? { advancementMinor: s.advancementMinor } : {}),
    ...(s.bondMinor !== undefined ? { bondMinor: s.bondMinor } : {}),
    ...(s.customerPaysDirectly !== undefined
      ? { customerPaysDirectly: s.customerPaysDirectly }
      : {}),
    ...(s.includedInSellerTotal !== undefined
      ? { includedInSellerTotal: s.includedInSellerTotal }
      : {}),
    ...(s.active !== undefined ? { active: s.active } : {}),
    ...(s.isDefault !== undefined ? { isDefault: s.isDefault } : {}),
    ...(s.effectiveTo !== undefined
      ? { effectiveTo: s.effectiveTo ? dateOnly(s.effectiveTo) : null }
      : {}),
    ...(s.notes !== undefined ? { notes: s.notes } : {}),
  };
}

/** One default at a time, so `selectSchedule` never has to break a tie between two. */
async function clearOtherDefaults(keepId: string): Promise<void> {
  await prisma.customsBrokerFeeSchedule.updateMany({
    where: { id: { not: keepId }, isDefault: true },
    data: { isDefault: false },
  });
}

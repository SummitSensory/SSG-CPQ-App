import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { prisma } from '../lib/prisma.js';
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
});

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
    return saveCustomsEntry(versionId, CustomsPatchSchema.parse(req.body ?? {}), req.user!.sub);
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
    if (patch.enabled === true) {
      const federal = await prisma.canadianTaxRegistration.findFirst({
        where: effectiveFederalRegistration(),
      });
      if (!federal) {
        throw new ValidationError(
          "Enter Summit's GST/HST registration before enabling Canadian proposals — without it every Canadian proposal reports a tax review and cannot be released.",
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

  /** Tax rates, for the admin table. Read-only here; corrections go by migration. */
  app.get('/cross-border/tax-rates', manage, async () => {
    return prisma.canadianTaxRate.findMany({
      orderBy: [{ province: 'asc' }, { taxType: 'asc' }, { effectiveFrom: 'desc' }],
    });
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
}

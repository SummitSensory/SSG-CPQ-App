import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import { currentMediaProgram, mediaRebateForVersion } from '../mediaRebate/service.js';

/**
 * The global Media Partnership Program (the $250 Customer Project Media Rebate), as
 * an editable record. One settings row, mutated in place — see the comment on
 * `MediaPartnershipProgram` in prisma/schema.prisma for why a mutable settings row plus
 * a separate content-addressed snapshot (frozen only at release) is the right shape
 * here, rather than a versioned-row-per-edit table.
 *
 * Editing is MEDIA_PARTNERSHIP_MANAGE, which only SYSTEM_ADMIN holds — same precedent
 * as LEGAL_MANAGE. Reading the effective program needs only PROPOSAL_READ, because any
 * rep who can open a proposal needs it to render the builder toggle and the document.
 */

const Timeframes = z.object({
  submissionDays: z.number().int().min(1).max(365),
  reviewBusinessDays: z.number().int().min(1).max(90),
  correctionDays: z.number().int().min(1).max(365),
  paymentDays: z.number().int().min(1).max(365),
});

/**
 * Layout, validated as the identical closed set `src/routes/legalDocuments.ts` uses
 * for the release and terms — same fonts, same bounds. This document prints onto the
 * same fixed 816x1056 sheet the proposal paginator builds, so the same reasoning
 * applies: bounded rather than free-form CSS, and the renderer clamps again besides.
 */
const Style = z.object({
  font: z.enum(['aptos', 'plex', 'georgia']).default('plex'),
  sizePt: z.coerce.number().min(7).max(12).default(9),
  lineHeight: z.coerce.number().min(1.1).max(1.9).default(1.35),
  align: z.enum(['justify', 'left']).default('justify'),
  titlePt: z.coerce.number().min(11).max(22).default(15),
});

const Content = z.object({
  introduction: z.string().trim().min(1).max(20000),
  mediaRequirements: z.string().trim().min(1).max(20000),
  acceptanceStandards: z.string().trim().min(1).max(20000),
  usageRights: z.string().trim().min(1).max(20000),
  privacyRestrictions: z.string().trim().min(1).max(20000),
  paymentTerms: z.string().trim().min(1).max(20000),
  participationLanguage: z.string().trim().min(1).max(2000),
  signatureAcknowledgment: z.string().trim().min(1).max(2000),
  timeframes: Timeframes,
  style: Style.optional(),
});

const UpdateBody = z.object({
  active: z.boolean(),
  customerFacingName: z.string().trim().min(1).max(200),
  internalName: z.string().trim().min(1).max(200),
  // Integer minor units (cents). Capped at $100,000 as a sanity bound, not a business rule.
  rebateAmountMinor: z.number().int().min(0).max(100_000_00),
  content: Content,
});

export function registerMediaPartnershipProgramRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.MEDIA_PARTNERSHIP_MANAGE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /** Full settings for the admin editor, including the shipped defaults when unsaved. */
  app.get('/media-partnership-program', manage, async () => currentMediaProgram());

  /**
   * What prints right now on a proposal that offers the program.
   *
   * Read by the proposal builder (to show the internal toggle's helper amount/text)
   * and the customer document renderer (to fill in the section) — PROPOSAL_READ, same
   * as `/legal-documents/effective`.
   */
  app.get('/media-partnership-program/effective', read, async () => currentMediaProgram());

  /** What a given proposal version's Media Program actually says — pinned or live. */
  app.get<{ Params: { id: string } }>('/proposals/versions/:id/media-rebate', read, async (req) =>
    mediaRebateForVersion(req.params.id),
  );

  /** Save the global defaults. Bumps `version`; does not touch any proposal. */
  app.put('/media-partnership-program', manage, async (req) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'This program is not valid.');
    }

    const before = await currentMediaProgram();
    const nextVersion = before.version + 1;

    const saved = await prisma.mediaPartnershipProgram.upsert({
      where: { key: 'default' },
      create: {
        key: 'default',
        active: parsed.data.active,
        customerFacingName: parsed.data.customerFacingName,
        internalName: parsed.data.internalName,
        rebateAmountMinor: parsed.data.rebateAmountMinor,
        content: parsed.data.content as unknown as Prisma.InputJsonValue,
        version: 1,
        updatedById: req.user!.sub,
      },
      update: {
        active: parsed.data.active,
        customerFacingName: parsed.data.customerFacingName,
        internalName: parsed.data.internalName,
        rebateAmountMinor: parsed.data.rebateAmountMinor,
        content: parsed.data.content as unknown as Prisma.InputJsonValue,
        version: nextVersion,
        updatedById: req.user!.sub,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'mediaPartnershipProgram.update',
      entity: 'MediaPartnershipProgram',
      entityId: 'default',
      details: { before, after: parsed.data },
    });

    return {
      active: saved.active,
      customerFacingName: saved.customerFacingName,
      internalName: saved.internalName,
      rebateAmountMinor: saved.rebateAmountMinor,
      content: saved.content,
      version: saved.version,
    };
  });
}

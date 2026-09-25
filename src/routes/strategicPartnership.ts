import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StrategicPartnershipStatus } from '@prisma/client';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { can } from '../authz/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { ValidationError } from '../lib/errors.js';
import {
  MAX_UPLOAD_BYTES,
  deleteFile,
  getFile,
  isFileStoreConfigured,
  putFile,
  safeSegment,
} from '../lib/fileStore.js';
import {
  PartnershipInputError,
  calculatePartnership,
  parseDollarsToMinor,
  parseHoursToHundredths,
  parsePercentToBps,
  serializeForClient,
} from '../strategicPartnership/calculate.js';
import { tokenCatalog, IMAGE_FIELDS } from '../strategicPartnership/copy.js';
import { searchPartnershipOrganizations } from '../strategicPartnership/orgSearch.js';
import {
  getPartnershipSettings,
  savePartnershipSettings,
} from '../strategicPartnership/settings.js';
import {
  type InputPatch,
  type PartnershipDto,
  type StoredFile,
  advancePartnership,
  approvePartnership,
  asStoredFile,
  createPartnership,
  generatePartnership,
  generationBlockers,
  listPartnerships,
  loadPartnership,
  markPartnershipSent,
  previewCopy,
  projectImageSlots,
  reopenPartnership,
  setImage,
  toDto,
  updatePartnership,
} from '../strategicPartnership/service.js';
import { productionDeps } from '../strategicPartnership/deps.js';
import {
  beginCanvaConnect,
  canvaStatus,
  completeCanvaConnect,
  disconnectCanva,
} from '../integrations/canva/oauth.js';

/**
 * Strategic Partnership Proposals.
 *
 * Reading needs PROPOSAL_READ, entering terms and generating needs PROPOSAL_WRITE —
 * the same people who build ordinary proposals. Approving the generated document is
 * PROPOSAL_REVIEW, the same line as reviewing a normal proposal: a rep cannot approve
 * their own partnership terms. The settings (Canva brand template, customer-facing
 * copy) and the Canva connection are INTEGRATIONS_MANAGE.
 *
 * Every calculated figure is computed on the server. The bodies below carry inputs
 * only; there is no field through which a client could set an output.
 */

const text = (max: number) => z.string().trim().max(max);
/** A form value: a string, or null / '' for "not entered". */
const formValue = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null ? null : String(v).trim() || null));
const centers = z.union([z.number().int().min(0).max(10_000), z.null()]).optional();

const InputBody = z.object({
  customerShortName: text(120).optional(),
  customerFullName: text(200).optional(),
  executiveName: text(200).optional(),
  executiveTitle: text(200).optional(),
  industry: text(200).optional(),
  partnerDiscountPercent: formValue,
  standardProjectValue: formValue,
  pmHoursReturnedPerCenter: formValue,
  pmHourValue: formValue,
  contributionMarginPerHour: formValue,
  year1PlannedCenters: centers,
  year2PlannedCenters: centers,
  year3PlannedCenters: centers,
  year4PlannedCenters: centers,
  year5PlannedCenters: centers,
  opportunityId: z.string().trim().min(1).max(64).nullable().optional(),
});

const CreateBody = InputBody.extend({ organizationId: z.string().trim().min(1) });

function parseOr<T>(v: string | null | undefined, parse: (s: string) => T): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  try {
    return parse(v);
  } catch (err) {
    if (err instanceof PartnershipInputError) throw new ValidationError(err.message);
    throw err;
  }
}

/** Form strings -> stored units. Throws ValidationError on a malformed value. */
export function toPatch(b: z.infer<typeof InputBody>): InputPatch {
  const patch: InputPatch = {
    customerShortName: b.customerShortName,
    customerFullName: b.customerFullName,
    executiveName: b.executiveName,
    executiveTitle: b.executiveTitle,
    industry: b.industry,
    partnerDiscountBps: parseOr(b.partnerDiscountPercent, parsePercentToBps),
    standardProjectValueMinor: parseOr(b.standardProjectValue, parseDollarsToMinor),
    pmHoursReturnedPerCenterHundredths: parseOr(b.pmHoursReturnedPerCenter, parseHoursToHundredths),
    pmHourValueMinor: parseOr(b.pmHourValue, parseDollarsToMinor),
    contributionMarginPerHourMinor: parseOr(b.contributionMarginPerHour, parseDollarsToMinor),
    year1PlannedCenters: b.year1PlannedCenters,
    year2PlannedCenters: b.year2PlannedCenters,
    year3PlannedCenters: b.year3PlannedCenters,
    year4PlannedCenters: b.year4PlannedCenters,
    year5PlannedCenters: b.year5PlannedCenters,
    opportunityId: b.opportunityId,
  };
  for (const k of Object.keys(patch) as Array<keyof InputPatch>) {
    if (patch[k] === undefined) delete patch[k];
  }
  return patch;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request',
    );
  }
  return parsed.data as z.infer<T>;
}

const STATUSES: StrategicPartnershipStatus[] = [
  'DRAFT',
  'READY_TO_GENERATE',
  'CALCULATING',
  'GENERATING_CANVA',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SENT',
  'ERROR',
];

const ListQuery = z.object({
  organizationId: z.string().trim().min(1).optional(),
  status: z
    .enum(STATUSES as [StrategicPartnershipStatus, ...StrategicPartnershipStatus[]])
    .optional(),
  q: z.string().trim().max(100).optional(),
});

/** Which actions the signed-in user may take, so the screen does not guess. */
function abilities(req: FastifyRequest) {
  const role = req.user!.role;
  return {
    write: can(role, Permission.PROPOSAL_WRITE),
    review: can(role, Permission.PROPOSAL_REVIEW),
    manage: can(role, Permission.INTEGRATIONS_MANAGE),
  };
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const ImageBody = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim(),
  base64: z.string().min(1),
});

function parseSlot(raw: string): 'logo' | number {
  if (raw === 'logo') return 'logo';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5)
    throw new ValidationError('Image slot is "logo" or 1 to 5.');
  return n;
}

function slotFile(
  dtoRow: { customerLogo: unknown; projectImages: unknown },
  slot: 'logo' | number,
) {
  return slot === 'logo'
    ? asStoredFile(dtoRow.customerLogo)
    : (projectImageSlots(dtoRow.projectImages)[slot - 1] ?? null);
}

function resultPage(title: string, message: string, ok: boolean): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;color:#20241f"><h1 style="font-size:20px;color:${ok ? '#3f9d78' : '#c2452f'}">${esc(title)}</h1><p style="line-height:1.5">${esc(message)}</p><p><a href="/">Back to the CRM</a></p></body></html>`;
}

export function registerStrategicPartnershipRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const review = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };
  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };
  const deps = productionDeps;

  const withAbilities = (req: FastifyRequest, dto: PartnershipDto) => ({
    ...dto,
    can: abilities(req),
  });

  /* ------------------------------------------------------------- settings */

  app.get('/strategic-partnerships/settings', read, async (req) => {
    const settings = await getPartnershipSettings();
    return { ...settings, tokens: tokenCatalog(), imageFields: IMAGE_FIELDS, can: abilities(req) };
  });

  app.put('/strategic-partnerships/settings', manage, async (req) => {
    const before = await getPartnershipSettings();
    const saved = await savePartnershipSettings(req.body, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'strategicPartnership.settings.update',
      entity: 'StrategicPartnershipSettings',
      entityId: 'default',
      details: { before, after: saved },
    });
    return { ...saved, tokens: tokenCatalog(), imageFields: IMAGE_FIELDS, can: abilities(req) };
  });

  /* ---------------------------------------------------------------- Canva */

  app.get('/integrations/canva', manage, async () => canvaStatus());

  app.post('/integrations/canva/connect', manage, async (req) => {
    const url = await beginCanvaConnect(req.user!.sub);
    return { url };
  });

  /** Canva's redirect back. Authenticated by the single-use state, not a session. */
  app.get('/integrations/canva/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (q.error || !q.code || !q.state) {
      return reply
        .status(400)
        .send(
          resultPage(
            'Canva was not connected',
            q.error_description ?? q.error ?? 'Canva sent an incomplete response.',
            false,
          ),
        );
    }
    try {
      const { connectedById } = await completeCanvaConnect(q.code, q.state);
      if (connectedById) {
        await recordAudit({
          actorId: connectedById,
          action: 'canva.connected',
          entity: 'CanvaConnection',
          entityId: 'default',
          details: {},
        });
      }
      return reply.send(
        resultPage(
          'Canva connected',
          'Strategic Partnership Proposals can now be generated in Canva.',
          true,
        ),
      );
    } catch (err) {
      logger.warn({ err }, 'canva: connect callback failed');
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      return reply.status(400).send(resultPage('Canva was not connected', message, false));
    }
  });

  app.delete('/integrations/canva', manage, async (req, reply) => {
    await disconnectCanva();
    await recordAudit({
      actorId: req.user!.sub,
      action: 'canva.disconnected',
      entity: 'CanvaConnection',
      entityId: 'default',
      details: {},
    });
    return reply.status(204).send();
  });

  /* -------------------------------------------------------------- records */

  /** Calculate without saving — the screen's live preview. Same engine as a save. */
  app.post('/strategic-partnerships/calculate', read, async (req) => {
    const b = parseBody(InputBody, req.body);
    const p = toPatch(b);
    const settings = await getPartnershipSettings();
    if (
      p.partnerDiscountBps == null ||
      p.standardProjectValueMinor == null ||
      p.pmHoursReturnedPerCenterHundredths == null ||
      p.pmHourValueMinor == null ||
      p.year1PlannedCenters == null ||
      p.year2PlannedCenters == null ||
      p.year3PlannedCenters == null
    ) {
      return { outputs: null };
    }
    try {
      const outputs = calculatePartnership(
        {
          partnerDiscountBps: p.partnerDiscountBps,
          standardProjectValueMinor: p.standardProjectValueMinor,
          pmHoursReturnedPerCenterHundredths: p.pmHoursReturnedPerCenterHundredths,
          pmHourValueMinor: p.pmHourValueMinor,
          year1PlannedCenters: p.year1PlannedCenters,
          year2PlannedCenters: p.year2PlannedCenters,
          year3PlannedCenters: p.year3PlannedCenters,
          year4PlannedCenters: p.year4PlannedCenters ?? null,
          year5PlannedCenters: p.year5PlannedCenters ?? null,
        },
        settings.content.scaleCenters,
      );
      return { outputs: serializeForClient(outputs) };
    } catch (err) {
      if (err instanceof PartnershipInputError) throw new ValidationError(err.message);
      throw err;
    }
  });

  /**
   * The new-proposal picker: anyone in the CRM, found by organization, contact name or
   * email, or deal name. CRM_READ, because it reads the CRM — the same gate as the
   * /crm/organizations search it replaces here.
   */
  app.get(
    '/strategic-partnerships/organization-search',
    { preHandler: requirePermission(Permission.CRM_READ) },
    async (req) => {
      const { q } = req.query as { q?: unknown };
      return { items: await searchPartnershipOrganizations(typeof q === 'string' ? q : '') };
    },
  );

  app.get('/strategic-partnerships', read, async (req) => {
    const q = parseBody(ListQuery, req.query);
    return { items: await listPartnerships(q), can: abilities(req) };
  });

  app.post('/strategic-partnerships', write, async (req, reply) => {
    const b = parseBody(CreateBody, req.body);
    const dto = await createPartnership(b.organizationId, toPatch(b), req.user!.sub);
    return reply.status(201).send(withAbilities(req, dto));
  });

  app.get<{ Params: { id: string } }>('/strategic-partnerships/:id', read, async (req) => {
    const row = await loadPartnership(req.params.id);
    const dto = toDto(row);
    const blockers = ['DRAFT', 'READY_TO_GENERATE', 'READY_FOR_REVIEW', 'ERROR'].includes(
      row.status,
    )
      ? await generationBlockers(row, deps())
      : [];
    return { ...withAbilities(req, dto), generationBlockers: blockers };
  });

  app.patch<{ Params: { id: string } }>('/strategic-partnerships/:id', write, async (req) => {
    const b = parseBody(InputBody, req.body);
    return withAbilities(req, await updatePartnership(req.params.id, toPatch(b), req.user!.sub));
  });

  app.get<{ Params: { id: string } }>('/strategic-partnerships/:id/copy', read, async (req) =>
    previewCopy(req.params.id),
  );

  /* --------------------------------------------------------------- images */

  app.post<{ Params: { id: string; slot: string } }>(
    '/strategic-partnerships/:id/images/:slot',
    write,
    async (req) => {
      const slot = parseSlot(req.params.slot);
      const b = parseBody(ImageBody, req.body);
      const ext = IMAGE_TYPES[b.contentType];
      if (!ext) throw new ValidationError('Images must be PNG or JPEG.');
      if (!isFileStoreConfigured()) {
        throw new ValidationError(
          'File storage is not configured on this deployment (BLOB_READ_WRITE_TOKEN).',
        );
      }
      const bytes = Buffer.from(b.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!bytes.length) throw new ValidationError('The image is empty.');
      if (bytes.length > MAX_UPLOAD_BYTES) {
        throw new ValidationError(
          `Images are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        );
      }
      const row = await loadPartnership(req.params.id);
      const stored = await putFile(
        `strategic-partnerships/${safeSegment(row.number, 'spp')}/${randomUUID()}-${safeSegment(b.filename, `image.${ext}`)}`,
        bytes,
        b.contentType,
      );
      const file: StoredFile = {
        url: stored.url,
        pathname: stored.pathname,
        filename: b.filename,
        contentType: b.contentType,
        bytes: stored.bytes,
      };
      const { dto, replaced } = await setImage(req.params.id, slot, file, req.user!.sub);
      if (replaced) await deleteFile(replaced.url).catch(() => undefined);
      return withAbilities(req, dto);
    },
  );

  app.delete<{ Params: { id: string; slot: string } }>(
    '/strategic-partnerships/:id/images/:slot',
    write,
    async (req) => {
      const slot = parseSlot(req.params.slot);
      const { dto, replaced } = await setImage(req.params.id, slot, null, req.user!.sub);
      if (replaced) await deleteFile(replaced.url).catch(() => undefined);
      return withAbilities(req, dto);
    },
  );

  /** The stored image, proxied — the blob store is private. */
  app.get<{ Params: { id: string; slot: string } }>(
    '/strategic-partnerships/:id/images/:slot',
    read,
    async (req, reply) => {
      const slot = parseSlot(req.params.slot);
      const row = await loadPartnership(req.params.id);
      const file = slotFile(row, slot);
      if (!file)
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'No image in that slot.' });
      const bytes = await getFile(file.url);
      return reply
        .header('Content-Type', file.contentType)
        .header('Cache-Control', 'private, max-age=300')
        .send(bytes);
    },
  );

  /* ----------------------------------------------------------- generation */

  app.post<{ Params: { id: string } }>('/strategic-partnerships/:id/generate', write, async (req) =>
    withAbilities(req, await generatePartnership(req.params.id, req.user!.sub, deps())),
  );

  /** Poll: take the next steps of an in-flight run. Harmless on any other record. */
  app.post<{ Params: { id: string } }>('/strategic-partnerships/:id/advance', write, async (req) =>
    withAbilities(req, await advancePartnership(req.params.id, deps())),
  );

  app.get<{ Params: { id: string } }>(
    '/strategic-partnerships/:id/pdf',
    read,
    async (req, reply) => {
      const row = await loadPartnership(req.params.id);
      if (!row.pdfUrl)
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: 'No PDF has been generated yet.' });
      const bytes = await getFile(row.pdfUrl);
      const name = `${safeSegment(row.customerShortName, 'Customer')}-Strategic-Partnership-Proposal-${row.number}.pdf`;
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(bytes);
    },
  );

  /* ---------------------------------------------------------- transitions */

  app.post<{ Params: { id: string } }>('/strategic-partnerships/:id/approve', review, async (req) =>
    withAbilities(req, await approvePartnership(req.params.id, req.user!.sub)),
  );

  app.post<{ Params: { id: string } }>('/strategic-partnerships/:id/sent', write, async (req) =>
    withAbilities(req, await markPartnershipSent(req.params.id, req.user!.sub)),
  );

  app.post<{ Params: { id: string } }>('/strategic-partnerships/:id/reopen', review, async (req) =>
    withAbilities(req, await reopenPartnership(req.params.id, req.user!.sub)),
  );
}

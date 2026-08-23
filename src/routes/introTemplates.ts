import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * Photographs for the proposal introduction pages.
 *
 * The introduction that prints ahead of an itemized proposal is a marketing
 * document: the same photographs on every Adventure proposal, the same on every
 * Soar. So the pictures belong to the template, managed once under Admin, and not
 * to the proposal — a rep does not choose photography per customer, and a proposal
 * carrying its own copy of five images would put megabytes into every version row
 * and every e-sign payload.
 *
 * Stored in UiSetting under `intro.art.<slot id>` as a data URL. Two reasons for a
 * data URL rather than a file on disk:
 *
 *   1. The deployment has no writable file store — it is serverless, and /public is
 *      whatever was in the build.
 *   2. The document is assembled in the browser and posted onwards to the PDF
 *      renderer, DocuSeal and monday. An inline image survives all three; a URL
 *      pointing back at an authenticated host does not.
 *
 * Reading is PROPOSAL_READ, because every rep building a proposal needs the images.
 * Writing is INTEGRATIONS_MANAGE, the same permission that governs the signing
 * document templates: editing customer-facing boilerplate is an admin act.
 */

const PREFIX = 'intro.art.';
/** Slot ids come from the registered templates in the browser, so they are constrained here. */
const SLOT_ID = /^[a-z0-9][a-z0-9_-]{1,60}$/i;
/** A data URL, and only an image one. Anything else would be written into a page verbatim. */
const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/**
 * Ceiling on one stored photograph. The browser downscales to a 1400 px long edge
 * before upload, which lands around 200-400 KB; 2 MB leaves room for a large
 * banner without letting an un-resized phone photo through.
 */
const MAX_CHARS = 2_000_000;

const ArtBody = z.object({ image: z.string().min(32).max(MAX_CHARS) });

function slotKey(raw: string): string {
  if (!SLOT_ID.test(raw)) throw new ValidationError('That is not a valid photo slot.');
  return PREFIX + raw;
}

export function registerIntroTemplateRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.INTEGRATIONS_MANAGE) };

  /**
   * Every introduction photograph, keyed by slot id.
   *
   * One request rather than one per slot: the builder needs the whole set before it
   * can render a document, and five round trips on every proposal open is five
   * chances to render a page with a hole in it.
   */
  app.get('/intro-templates/art', read, async () => {
    const rows = await prisma.uiSetting.findMany({ where: { key: { startsWith: PREFIX } } });
    const art: Record<string, string> = {};
    for (const r of rows) art[r.key.slice(PREFIX.length)] = r.value;
    return { art };
  });

  /** Set one slot's photograph. */
  app.put('/intro-templates/art/:slot', manage, async (req) => {
    const { slot } = req.params as { slot: string };
    const key = slotKey(slot);
    const parsed = ArtBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Send the image as a data URL in `image`.');
    const image = parsed.data.image.trim();
    if (!DATA_URL.test(image)) {
      throw new ValidationError(
        'That image could not be read. Upload a JPEG, PNG or WebP — the browser converts it before sending.',
      );
    }
    await prisma.uiSetting.upsert({
      where: { key },
      create: { key, value: image, updatedById: req.user!.sub },
      update: { value: image, updatedById: req.user!.sub, updatedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'proposal.intro.art.set',
      entity: 'UiSetting',
      entityId: key,
      // The image itself is not audited — the fact and its size are what anyone
      // reviewing this later needs, and a base64 blob in the audit log is noise.
      details: { slot, bytes: image.length },
    });
    return { slot, saved: true };
  });

  /** Remove one slot's photograph. The page then prints without it. */
  app.delete('/intro-templates/art/:slot', manage, async (req) => {
    const { slot } = req.params as { slot: string };
    const key = slotKey(slot);
    await prisma.uiSetting.deleteMany({ where: { key } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'proposal.intro.art.clear',
      entity: 'UiSetting',
      entityId: key,
      details: { slot },
    });
    return { slot, saved: true };
  });
}

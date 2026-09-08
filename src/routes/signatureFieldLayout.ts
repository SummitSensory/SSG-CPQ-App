import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import { SIGNATURE_FIELD_SLOT_IDS } from '../integrations/docuseal/assembly.js';

/**
 * Manual pixel nudges for the six signature/date boxes the proposal and acknowledgment
 * pages already print — see the SignatureFieldLayout model comment in schema.prisma and
 * SIGNATURE_FIELD_SLOT_IDS in assembly.ts for what the six ids are and why they exist.
 *
 * One singleton row, same pattern as a legal document's own layout fields: read by
 * `public/signature-field-layout.js` at sign-in (fire-and-forget, same pattern as
 * `public/contract-pages.js`'s legal-text fetch) so `public/proposal-document.js` and
 * `public/contract-pages.js` can apply the saved offset the moment they build each box,
 * everywhere a proposal is rendered — the screen preview, the customer's own PDF copy,
 * the monday push, and the DocuSeal signing package alike, since all four render the
 * exact same generated HTML. Written only from the drag-to-place admin editor
 * (`public/signature-field-layout-admin.js`).
 */

const KNOWN_IDS = new Set(SIGNATURE_FIELD_SLOT_IDS);

const Offset = z.object({
  // A box only ever needs to move a modest distance from where the surrounding layout
  // already puts it — the label, the line above it, the rest of the printed page are
  // all still exactly where they were. Bounded so a typo (a stray extra zero) cannot
  // drag a box off a printed sheet entirely; the live preview in the admin editor makes
  // the same clamp visible before it is ever saved.
  top: z.coerce.number().min(-300).max(300),
  left: z.coerce.number().min(-300).max(300),
});

const Offsets = z.record(z.string(), Offset).superRefine((v, ctx) => {
  const unknown = Object.keys(v).filter((k) => !KNOWN_IDS.has(k));
  if (unknown.length) {
    ctx.addIssue({
      code: 'custom',
      message: `Unknown signature field slot: ${unknown.join(', ')}.`,
    });
  }
});

const SINGLETON_KEY = 'default';

async function currentOffsets(): Promise<Record<string, { top: number; left: number }>> {
  const row = await prisma.signatureFieldLayout.findUnique({ where: { key: SINGLETON_KEY } });
  const raw = (row?.offsets as Record<string, { top: number; left: number }> | null) ?? {};
  // Filter to known ids on the way out too, not just on the way in — a slot renamed
  // after being saved should not keep silently applying a stale offset under its old
  // name, and an admin who never re-saves should still see it drop off cleanly.
  const out: Record<string, { top: number; left: number }> = {};
  for (const id of SIGNATURE_FIELD_SLOT_IDS) {
    const v = raw[id];
    if (v && Number.isFinite(v.top) && Number.isFinite(v.left))
      out[id] = { top: v.top, left: v.left };
  }
  return out;
}

export function registerSignatureFieldLayoutRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.LEGAL_MANAGE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * What every proposal renders right now. Read by `public/signature-field-layout.js`,
   * the same PROPOSAL_READ level as `/legal-documents/effective`: every rep who can open
   * a proposal renders these boxes.
   *
   * `slotIds` rides along so the admin editor's canvas draws exactly the boxes this
   * route will accept — never its own separate copy of the list.
   */
  app.get('/signature-field-layout/effective', read, async () => ({
    offsets: await currentOffsets(),
    slotIds: SIGNATURE_FIELD_SLOT_IDS,
  }));

  /** Save the placement dragged out in the admin editor. */
  app.put('/signature-field-layout', manage, async (req) => {
    const parsed = Offsets.safeParse(req.body && (req.body as { offsets?: unknown }).offsets);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'That placement is not valid.');
    }
    await prisma.signatureFieldLayout.upsert({
      where: { key: SINGLETON_KEY },
      create: { key: SINGLETON_KEY, offsets: parsed.data, updatedById: req.user!.sub },
      update: { offsets: parsed.data, updatedById: req.user!.sub },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'signatureFieldLayout.save',
      entity: 'SignatureFieldLayout',
      entityId: SINGLETON_KEY,
      details: { offsets: parsed.data },
    });
    return { offsets: await currentOffsets(), slotIds: SIGNATURE_FIELD_SLOT_IDS };
  });
}

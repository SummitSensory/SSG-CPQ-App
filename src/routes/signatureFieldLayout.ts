import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import {
  SIGNATURE_FIELD_SLOT_IDS,
  SIGNATURE_FIELD_DEFAULTS,
} from '../integrations/docuseal/assembly.js';
import {
  getSavedFieldLayout,
  saveFieldLayout,
  type SavedFieldLayout,
} from '../integrations/docuseal/fieldLayoutStore.js';

/**
 * Manual placement AND size for the six signature/date boxes the proposal and
 * acknowledgment pages already print — see the SignatureFieldLayout model comment in
 * schema.prisma and SIGNATURE_FIELD_SLOT_IDS/SIGNATURE_FIELD_DEFAULTS in assembly.ts for
 * what the six ids are and what an unsaved property falls back to.
 *
 * Position (`top`/`left`) and size (`width`/`height`/`fontSize`) are two independent
 * things applied in two different places, not one setting read two ways:
 *
 *   - Position is a purely cosmetic CSS nudge on the printed BLANK line — read by
 *     `public/signature-field-layout.js` at sign-in (fire-and-forget, same pattern as
 *     `public/contract-pages.js`'s legal-text fetch) so `public/proposal-document.js`
 *     and `public/contract-pages.js` can apply it the moment they build each box,
 *     everywhere a proposal renders (screen preview, customer PDF, monday push,
 *     DocuSeal package) — all four build from the same generated HTML.
 *   - Size is the actual DocuSeal FIELD dimensions/font — the thing a signature or
 *     date renders INTO once signed — read only at send time, server-side, by
 *     `sendProposalForSignature` (service.ts) and threaded into `buildPackage`'s
 *     `fieldSizeOverrides`. It never touches the printed blank line's own box, which is
 *     what keeps a size change from being able to break today's unsigned template.
 *
 * Written only from the drag-to-place, drag-to-resize admin editor
 * (`public/signature-field-layout-admin.js`).
 */

const KNOWN_IDS = new Set(SIGNATURE_FIELD_SLOT_IDS);

const Offset = z.object({
  // A box only ever needs to move a modest distance from where the surrounding layout
  // already puts it — the label, the line above it, the rest of the printed page are
  // all still exactly where they were. Bounded so a typo (a stray extra zero) cannot
  // drag a box off a printed sheet entirely; the live preview in the admin editor makes
  // the same clamp visible before it is ever saved.
  top: z.coerce.number().min(-300).max(300).optional(),
  left: z.coerce.number().min(-300).max(300).optional(),
  // Bounded well above and below every shipped default (40-260 wide, 20-46 tall,
  // 12-18pt) so a field can be meaningfully resized in either direction without being
  // able to recreate the exact incident SIGNATURE_FIELD_DEFAULTS's own comment
  // describes: an oversized field pushing a signer's block off the page.
  width: z.coerce.number().min(40).max(500).optional(),
  height: z.coerce.number().min(12).max(140).optional(),
  fontSize: z.coerce.number().min(8).max(40).optional(),
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

/**
 * Filtered to known ids on the way out, not just on the way in — a slot renamed after
 * being saved should not keep silently applying a stale entry under its old name, and
 * an admin who never re-saves should still see it drop off cleanly.
 */
async function currentOffsets(): Promise<Record<string, SavedFieldLayout>> {
  const raw = await getSavedFieldLayout();
  const out: Record<string, SavedFieldLayout> = {};
  for (const id of SIGNATURE_FIELD_SLOT_IDS) {
    const v = raw[id];
    if (v) out[id] = v;
  }
  return out;
}

export function registerSignatureFieldLayoutRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.LEGAL_MANAGE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * What every proposal renders right now, plus what an untouched box's size
   * defaults to. Read by `public/signature-field-layout.js` and by the admin editor,
   * the same PROPOSAL_READ level as `/legal-documents/effective`: every rep who can
   * open a proposal renders these boxes.
   *
   * `slotIds` and `defaults` ride along so the admin editor's canvas draws exactly the
   * boxes and sizes this route already knows about — never its own separate copy.
   */
  app.get('/signature-field-layout/effective', read, async () => ({
    offsets: await currentOffsets(),
    slotIds: SIGNATURE_FIELD_SLOT_IDS,
    defaults: SIGNATURE_FIELD_DEFAULTS,
  }));

  /** Save the placement/size set in the admin editor. */
  app.put('/signature-field-layout', manage, async (req) => {
    const parsed = Offsets.safeParse(req.body && (req.body as { offsets?: unknown }).offsets);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'That placement is not valid.');
    }
    await saveFieldLayout(parsed.data, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'signatureFieldLayout.save',
      entity: 'SignatureFieldLayout',
      entityId: 'default',
      details: { offsets: parsed.data },
    });
    return {
      offsets: await currentOffsets(),
      slotIds: SIGNATURE_FIELD_SLOT_IDS,
      defaults: SIGNATURE_FIELD_DEFAULTS,
    };
  });
}

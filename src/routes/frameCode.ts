import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError } from '../lib/errors.js';
import {
  FRAME_CODE_SAMPLES,
  FRAME_FEATURE_KEYS,
  FRAME_FEATURE_LABELS,
  FRAME_QTY_MODES,
  FRAME_SEGMENT_KEYS,
  FRAME_SEGMENT_LABELS,
  FRAME_SHAPE_KEYS,
  buildFrameCode,
  conventionProblems,
  type FrameCodeConvention,
} from '../proposals/frameCode.js';
import {
  activeFrameCodeConvention,
  frameCodeConventions,
  saveFrameCodeConvention,
} from '../proposals/frameCodeStore.js';

/**
 * Administration → Frame naming. Reading and editing are FRAME_CODE_MANAGE, which only
 * SYSTEM_ADMIN holds: nobody else needs the screen, and the builder never reads the
 * convention — the server names the frame when it prices it.
 */

const Letters = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase());

const ConventionBody = z.object({
  segments: z.array(z.enum(FRAME_SEGMENT_KEYS)),
  shapes: z.object({
    Square: Letters,
    Rectangle: Letters,
    'L-Shape': Letters,
    'T-Shape': Letters,
  }),
  features: z.array(
    z.object({
      key: z.enum(FRAME_FEATURE_KEYS),
      letter: Letters,
      qty: z.enum(FRAME_QTY_MODES),
    }),
  ),
  monkeyBarsCountAsBeam: z.boolean(),
});

function parseConvention(body: unknown): FrameCodeConvention {
  const parsed = ConventionBody.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? 'This naming convention is not valid.',
    );
  }
  return parsed.data;
}

/** The sample configurations named under a convention, for the live preview. */
function samplesFor(c: FrameCodeConvention) {
  return FRAME_CODE_SAMPLES.map((s) => {
    try {
      return { label: s.label, code: buildFrameCode(s.answers, c) };
    } catch (err) {
      return { label: s.label, code: '', error: (err as Error).message };
    }
  });
}

export function registerFrameCodeRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.FRAME_CODE_MANAGE) };

  app.get('/frame-code/convention', manage, async () => {
    const [active, history] = await Promise.all([
      activeFrameCodeConvention(),
      frameCodeConventions(),
    ]);
    return {
      active,
      samples: samplesFor(active.convention),
      // Newest first, without the read-only legacy convention (version 0).
      history: history
        .filter((h) => h.version > 0)
        .reverse()
        .map((h) => ({
          version: h.version,
          note: h.note ?? null,
          createdAt: h.createdAt ?? null,
          createdById: h.createdById ?? null,
          example: samplesFor(h.convention)[0]?.code ?? '',
        })),
      labels: {
        features: FRAME_FEATURE_LABELS,
        segments: FRAME_SEGMENT_LABELS,
        shapes: FRAME_SHAPE_KEYS,
        qtyModes: FRAME_QTY_MODES,
      },
    };
  });

  /** Name the samples under an unsaved convention. Answers problems as data, not 400s. */
  app.post('/frame-code/convention/preview', manage, async (req) => {
    const c = parseConvention(req.body);
    const problems = conventionProblems(c);
    return { problems, samples: problems.length ? [] : samplesFor(c) };
  });

  /** Save a new version. Proposals already named keep their names. */
  app.put('/frame-code/convention', manage, async (req) => {
    const body = (req.body || {}) as { convention?: unknown; note?: unknown };
    const c = parseConvention(body.convention);
    const problems = conventionProblems(c);
    if (problems.length) throw new ValidationError(problems.join(' '));
    const note =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    const before = await activeFrameCodeConvention();
    const saved = await saveFrameCodeConvention(c, note, req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'frameCodeConvention.update',
      entity: 'FrameCodeConvention',
      entityId: String(saved.version),
      details: { before: before.convention, beforeVersion: before.version, after: c, note },
    });
    return { active: saved, samples: samplesFor(c) };
  });
}

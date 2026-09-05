import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import {
  loadTipsGuideProfile,
  saveTipsGuideProfile,
  resetTipsGuideProfile,
  TIPS_GUIDE_DEFAULTS,
  TipsGuidePatch,
} from '../ui/tipsGuide.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Tips & Tricks — the page-by-page help bubble (public/tips-and-tricks.js).
 *
 * Reading the guide's profile needs no permission beyond being signed in: every
 * user with the feature turned on renders the widget. Changing WHO appears on it
 * is gated behind UI_MANAGE (SYSTEM_ADMIN), the same split PROPOSAL_READ /
 * LEGAL_MANAGE uses for the legal document text.
 *
 * The per-user on/off switch (User.tipsEnabled) is not here — it is ordinary
 * profile self-service, so it rides along on GET/PATCH /auth/me next to name,
 * title and phone rather than getting its own endpoint.
 */
export function registerTipsRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.UI_MANAGE) };

  app.get('/tips/guide', { preHandler: requireAuth }, async () => ({
    profile: await loadTipsGuideProfile(),
    defaults: TIPS_GUIDE_DEFAULTS,
  }));

  app.patch('/tips/guide', manage, async (req) => {
    const parsed = TipsGuidePatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile');
    }
    return { profile: await saveTipsGuideProfile(parsed.data, req.user!.sub) };
  });

  app.post('/tips/guide/reset', manage, async (req) => ({
    profile: await resetTipsGuideProfile(req.user!.sub),
  }));
}

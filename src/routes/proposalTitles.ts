import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { loadTitlePresets, saveTitlePresets, TitlePresetSave } from '../proposals/titlePresets.js';

/**
 * Prebuilt proposal titles (see src/proposals/titlePresets.ts).
 *
 * Reading needs only PROPOSAL_READ — every rep who can start a proposal sees the
 * dropdown. Editing the list sits with PROPOSAL_REVIEW, the same permission as the
 * standard proposal notes beside it under Administration → Proposal content: both are
 * reusable proposal wording a manager curates for the team.
 */
export function registerProposalTitleRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };

  app.get('/proposal-titles', read, async () => loadTitlePresets());

  app.put('/proposal-titles', manage, async (req) => {
    const parsed = TitlePresetSave.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Those titles could not be read.',
      );
    }
    return saveTitlePresets(parsed.data, req.user!.sub);
  });
}

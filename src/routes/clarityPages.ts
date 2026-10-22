import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { computeClarityPages } from '../proposals/clarityPages.js';
import { frameCodeConventions } from '../proposals/frameCodeStore.js';

/**
 * The "What's Included" and "Before You Sign" pages for one proposal, computed from
 * the model code it prints and the lines on it (src/proposals/clarityPages.ts).
 *
 * The builder calls this whenever either changes and keeps the answer on the version
 * (meta.clarityPages.snapshot); the document only ever prints that snapshot, so a
 * released proposal is not re-worded when the convention changes afterwards.
 */
const Body = z.object({
  code: z.string().max(80),
  lines: z
    .array(
      z.object({
        lineType: z.string().max(20).optional(),
        name: z.string().max(500).optional(),
        sku: z.string().max(80).optional(),
        quantity: z.number().optional(),
      }),
    )
    .max(2000),
  answers: z
    .object({
      length: z.number().optional(),
      width: z.number().optional(),
      trolleyType: z.string().max(20).optional(),
    })
    .nullish(),
});

export function registerClarityPageRoutes(app: FastifyInstance): void {
  app.post(
    '/proposals/clarity-pages',
    { preHandler: requirePermission(Permission.PROPOSAL_READ) },
    async (req) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request.');
      }
      const snapshot = computeClarityPages(parsed.data, await frameCodeConventions());
      return { snapshot };
    },
  );
}

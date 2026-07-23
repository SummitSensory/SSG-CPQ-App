import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';

const TemplateBody = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  data: z.record(z.unknown()),
});

/** Named, reusable proposal starting points (groups, notes, standard lines, order). */
export function registerProposalTemplateRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  app.get('/proposal-templates', read, async () =>
    prisma.proposalTemplate.findMany({ orderBy: { name: 'asc' } }),
  );

  app.get('/proposal-templates/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const t = await prisma.proposalTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundError('Template not found');
    return t;
  });

  app.post('/proposal-templates', write, async (req, reply) => {
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const t = await prisma.proposalTemplate.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        data: parsed.data.data as object,
        createdById: req.user!.sub,
      },
    });
    return reply.status(201).send(t);
  });

  app.patch('/proposal-templates/:id', write, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = TemplateBody.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.proposalTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    return prisma.proposalTemplate.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description ?? null } : {}),
        ...(parsed.data.data ? { data: parsed.data.data as object } : {}),
      },
    });
  });

  app.delete('/proposal-templates/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.proposalTemplate.delete({ where: { id } }).catch(() => { throw new NotFoundError('Template not found'); });
    return reply.status(204).send();
  });
}

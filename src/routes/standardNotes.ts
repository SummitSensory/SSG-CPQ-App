import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Standard proposal notes: the reusable boilerplate blocks (terms, freight,
 * tax language) that print either inside the line-item table or beneath the
 * signature lines. Notes flagged autoInclude are dropped onto every new
 * proposal so nobody has to remember to pick them.
 */
const NoteSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1),
  placement: z.enum(['TABLE', 'FOOTER']).default('TABLE'),
  autoInclude: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
});

export function registerStandardNoteRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };

  app.get('/standard-notes', read, async () =>
    prisma.standardNote.findMany({ orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }] }),
  );

  app.post('/standard-notes', manage, async (req, reply) => {
    const parsed = NoteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const created = await prisma.standardNote.create({ data: parsed.data });
    reply.code(201);
    return created;
  });

  app.patch('/standard-notes/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = NoteSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    return prisma.standardNote.update({ where: { id }, data: parsed.data });
  });

  app.delete('/standard-notes/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.standardNote.delete({ where: { id } });
    reply.code(204);
    return null;
  });
}

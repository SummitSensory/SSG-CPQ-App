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
  /**
   * Comma-separated part numbers that pull this note onto a proposal.
   *
   * Normalised on the way in — upper-cased, trimmed, de-duplicated, newlines
   * treated as separators — so the builder can match on part number without
   * caring how the list was typed.
   */
  triggerParts: z
    .string()
    .max(2000)
    .nullish()
    .transform((v) => {
      const parts = String(v ?? '')
        .split(/[,\n]/)
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);
      return parts.length ? [...new Set(parts)].join(', ') : null;
    }),
  /**
   * When this note applies. Null means always.
   *
   * A pair is two notes, one DEPOSIT_SHOWN and one DEPOSIT_HIDDEN: the builder keeps
   * whichever matches the proposal and removes the other, so a proposal that takes
   * payment in full never carries wording about a deposit. Left as a string rather
   * than an enum so a new condition needs no migration.
   */
  condition: z
    .enum(['DEPOSIT_SHOWN', 'DEPOSIT_HIDDEN'])
    .nullish()
    .transform((v) => v ?? null),
  /** Print the note in an outlined box on the proposal. See StandardNote.emphasis. */
  emphasis: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
});

export function registerStandardNoteRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const manage = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };

  app.get('/standard-notes', read, async () =>
    prisma.standardNote.findMany({
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }],
    }),
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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../lib/errors.js';

/**
 * Internal notes and the two customer-level dates.
 *
 * The notes are a log kept against the CUSTOMER. A proposal is only where a note was
 * written — it is not what the note belongs to, so rejecting, expiring or deleting a
 * proposal never takes the account history with it. The builder shows the log split
 * in two: what was written from the proposal on screen, and everything else known
 * about this customer.
 *
 * Read and write are both PROPOSAL_READ: anyone who can open a proposal can add to
 * its notes. Withholding write from people who can read produced the obvious failure
 * — the person who took the call could not record it.
 */
const NoteSchema = z.object({
  body: z.string().min(1, 'A note needs some text.').max(8000),
  /** Which proposal this was written from. Absent = a note about the customer. */
  proposalId: z.string().nullish(),
});

/**
 * Dates arrive as YYYY-MM-DD (an `<input type="date">`) and are stored at UTC
 * midnight, so the day a rep picked is the day everyone reads back regardless of the
 * server's zone. An empty string clears the date rather than failing validation —
 * clearing is how a rep says "no follow-up planned".
 */
const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date.')
  .or(z.literal(''))
  .nullish()
  .transform((v) => (v ? new Date(v + 'T00:00:00.000Z') : null));

const DatesSchema = z.object({
  decisionFrom: dateField,
  decisionTo: dateField,
  followUpDate: dateField,
});

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export function registerCustomerNoteRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /**
   * The whole panel in one call: the dates, the notes written from this proposal, and
   * the rest of the customer's log. Notes carried over from other proposals stay in
   * the customer list but keep their proposal number, so a promise made on an earlier
   * quote can be traced back to it.
   */
  app.get('/crm/organizations/:organizationId/notes', read, async (req) => {
    const { organizationId } = req.params as { organizationId: string };
    const { proposalId } = req.query as { proposalId?: string };

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, decisionFrom: true, decisionTo: true, followUpDate: true },
    });
    if (!org) throw new NotFoundError('Customer not found.');

    const notes = await prisma.customerNote.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    // Proposal numbers for the notes that came from a proposal. One query, not one
    // per note; a note whose proposal has since been deleted simply loses the tag.
    const ids = [...new Set(notes.map((n) => n.proposalId).filter((v): v is string => Boolean(v)))];
    const numbers = new Map<string, string>();
    if (ids.length) {
      const props = await prisma.proposal.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true },
      });
      for (const p of props) numbers.set(p.id, p.number);
    }

    const shape = (n: (typeof notes)[number]) => ({
      id: n.id,
      body: n.body,
      authorId: n.authorId,
      authorName: n.authorName,
      createdAt: n.createdAt.toISOString(),
      proposalId: n.proposalId,
      proposalNumber: n.proposalId ? (numbers.get(n.proposalId) ?? null) : null,
    });

    return {
      organizationId: org.id,
      customerName: org.name,
      dates: {
        decisionFrom: iso(org.decisionFrom),
        decisionTo: iso(org.decisionTo),
        followUpDate: iso(org.followUpDate),
      },
      proposal: proposalId ? notes.filter((n) => n.proposalId === proposalId).map(shape) : [],
      customer: notes.filter((n) => !proposalId || n.proposalId !== proposalId).map(shape),
    };
  });

  app.post('/crm/organizations/:organizationId/notes', read, async (req, reply) => {
    const { organizationId } = req.params as { organizationId: string };
    const parsed = NoteSchema.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid note.');

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) throw new NotFoundError('Customer not found.');

    const author = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    const created = await prisma.customerNote.create({
      data: {
        organizationId,
        proposalId: parsed.data.proposalId || null,
        authorId: req.user!.sub,
        authorName: author?.name || author?.email || 'Unknown',
        body: parsed.data.body.trim(),
      },
    });
    reply.code(201);
    return {
      id: created.id,
      body: created.body,
      authorId: created.authorId,
      authorName: created.authorName,
      createdAt: created.createdAt.toISOString(),
      proposalId: created.proposalId,
      proposalNumber: null,
    };
  });

  /**
   * Remove a note. The log is not editable, so this is the only way to take something
   * back — and only its author or a system admin may, because a shared account
   * history anyone can prune is not a history.
   */
  app.delete('/customer-notes/:id', read, async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await prisma.customerNote.findUnique({
      where: { id },
      select: { authorId: true },
    });
    if (!note) throw new NotFoundError('Note not found.');
    if (note.authorId !== req.user!.sub && req.user!.role !== 'SYSTEM_ADMIN') {
      throw new ForbiddenError('Only the person who wrote a note can remove it.');
    }
    await prisma.customerNote.delete({ where: { id } });
    reply.code(204);
    return null;
  });

  /** The ideal decision timeline and the follow-up date. Both live on the customer. */
  app.patch('/crm/organizations/:organizationId/dates', read, async (req) => {
    const parsedAll = DatesSchema.partial().safeParse(req.body);
    if (!parsedAll.success)
      throw new ValidationError(parsedAll.error.issues[0]?.message ?? 'Invalid date.');
    const { organizationId } = req.params as { organizationId: string };
    const data = parsedAll.data;

    // A range that runs backwards is a typo, and one worth catching now rather than
    // three weeks later when nobody remembers which end was meant.
    const current = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { decisionFrom: true, decisionTo: true },
    });
    if (!current) throw new NotFoundError('Customer not found.');
    const from = 'decisionFrom' in data ? data.decisionFrom : current.decisionFrom;
    const to = 'decisionTo' in data ? data.decisionTo : current.decisionTo;
    if (from && to && from > to)
      throw new ValidationError('The decision window ends before it starts.');

    const org = await prisma.organization.update({
      where: { id: organizationId },
      data,
      select: { decisionFrom: true, decisionTo: true, followUpDate: true },
    });
    return {
      decisionFrom: iso(org.decisionFrom),
      decisionTo: iso(org.decisionTo),
      followUpDate: iso(org.followUpDate),
    };
  });

  /**
   * Customers whose follow-up date has arrived. Feeds the dashboard count — a date
   * nobody is shown is a date nobody acts on.
   *
   * "Due" is today or earlier, compared in UTC because that is how the dates were
   * stored. The oldest, and so most overdue, sorts first.
   */
  app.get('/crm/follow-ups', read, async () => {
    const now = new Date();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59),
    );
    const rows = await prisma.organization.findMany({
      where: { followUpDate: { not: null, lte: end } },
      orderBy: { followUpDate: 'asc' },
      select: { id: true, name: true, followUpDate: true, decisionFrom: true, decisionTo: true },
      take: 50,
    });
    return {
      count: rows.length,
      rows: rows.map((r) => ({
        organizationId: r.id,
        customer: r.name,
        followUpDate: iso(r.followUpDate),
        decisionFrom: iso(r.decisionFrom),
        decisionTo: iso(r.decisionTo),
      })),
    };
  });
}

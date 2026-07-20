import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import {
  createProposal, updateVersionContent, createNewVersion, changeStatus, compareProposalVersions,
} from '../proposals/service.js';
import { resolveVisibleSections, reorderSections, type ProposalSection } from '../proposals/sections.js';

const SectionSchema = z.object({
  id: z.string(), type: z.string(), title: z.string(), order: z.number().int(),
  enabled: z.boolean(),
  condition: z.object({ field: z.string(), equals: z.unknown() }).optional(),
  body: z.string().optional(), data: z.record(z.unknown()).optional(),
});
const ItemSchema = z.object({
  ref: z.string(), productId: z.string(), name: z.string(),
  kind: z.enum(['INCLUDED', 'OPTIONAL', 'ALTERNATE']),
  quantity: z.number().int().positive(), alternateForRef: z.string().optional(),
});
const CreateSchema = z.object({
  organizationId: z.string().min(1), title: z.string().min(2),
  sections: z.array(SectionSchema), items: z.array(ItemSchema),
  priceSnapshotId: z.string().optional(), ruleSnapshotId: z.string().optional(),
  expirationDate: z.coerce.date().optional(),
});

export function registerProposalRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };
  const review = { preHandler: requirePermission(Permission.PROPOSAL_REVIEW) };
  const release = { preHandler: requirePermission(Permission.PROPOSAL_RELEASE) };

  app.get('/proposals', read, async () =>
    prisma.proposal.findMany({ orderBy: { updatedAt: 'desc' }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } }),
  );

  app.post('/proposals', write, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { expirationDate, ...rest } = parsed.data;
    const result = await createProposal({ ...rest, expirationDate: expirationDate ?? null }, req.user!.sub);
    return reply.status(201).send(result);
  });

  app.get('/proposals/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.proposal.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'asc' } } } });
  });

  // Preview: returns visible sections resolved for the given facts (conditional + reordered).
  app.post('/proposals/versions/:versionId/preview', read, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const facts = (req.body as { facts?: Record<string, unknown> })?.facts ?? {};
    const v = await prisma.proposalVersion.findUnique({ where: { id: versionId } });
    if (!v) throw new ValidationError('Version not found');
    const sections = v.sections as unknown as ProposalSection[];
    return { visibleSections: resolveVisibleSections(sections, facts), status: v.status, frozen: v.frozen };
  });

  app.patch('/proposals/versions/:versionId', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    const body = req.body as { sections?: ProposalSection[]; items?: unknown[]; orderedSectionIds?: string[]; expirationDate?: string };
    let sections = body.sections;
    if (body.orderedSectionIds && sections) sections = reorderSections(sections, body.orderedSectionIds);
    await updateVersionContent(versionId, {
      ...(sections ? { sections } : {}),
      ...(body.items ? { items: body.items as never } : {}),
      ...(body.expirationDate ? { expirationDate: new Date(body.expirationDate) } : {}),
    }, req.user!.sub);
    return { ok: true };
  });

  // New version — the ONLY way to change a released proposal.
  app.post('/proposals/:id/versions', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await createNewVersion(id, req.user!.sub);
    return reply.status(201).send(result);
  });

  app.get('/proposals/:id/compare', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { a?: string; b?: string };
    if (!q.a || !q.b) throw new ValidationError('a and b version numbers required');
    return compareProposalVersions(id, parseInt(q.a, 10), parseInt(q.b, 10));
  });

  // Status transitions, permission-gated by target.
  app.post('/proposals/versions/:versionId/submit-review', write, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'INTERNAL_REVIEW', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'INTERNAL_REVIEW' };
  });
  app.post('/proposals/versions/:versionId/return-draft', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'DRAFT', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'DRAFT' };
  });
  app.post('/proposals/versions/:versionId/release', release, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'RELEASED', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'RELEASED' };
  });
  app.post('/proposals/versions/:versionId/accept', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'ACCEPTED', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'ACCEPTED' };
  });
  app.post('/proposals/versions/:versionId/reject', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'REJECTED', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'REJECTED' };
  });
  app.post('/proposals/versions/:versionId/expire', review, async (req) => {
    const { versionId } = req.params as { versionId: string };
    await changeStatus(versionId, 'EXPIRED', req.user!.sub, (req.body as { note?: string })?.note);
    return { status: 'EXPIRED' };
  });
}

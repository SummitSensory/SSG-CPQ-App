import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import { deleteFile } from '../lib/fileStore.js';
import {
  ALLOWED_RENDERING_TYPES,
  MAX_RENDERING_BYTES,
  isRenderingUploadConfigured,
  issueRenderingUploadToken,
  renderingPath,
  verifyRenderingUpload,
} from '../lib/renderingStore.js';

/**
 * Design renderings — CAD exports, photorealistic renders — uploaded browser-to-
 * blob directly. See lib/renderingStore.ts for why: these routinely exceed the
 * ~4.5 MB Vercel serverless function body limit, so the bytes never touch this
 * server. What runs here is two small JSON round trips around that upload:
 *
 *   1. upload-token — mint a token scoped to one pathname, one content type, one
 *      size ceiling, so the browser can PUT straight to blob storage.
 *   2. the completion POST — record the result, after independently confirming
 *      with blob storage itself that the file is really there and reading back
 *      its authoritative size and content type rather than trusting the browser.
 */

const UploadTokenBody = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
});

const RecordBody = z.object({
  url: z.string().trim().url(),
  pathname: z.string().trim().min(1).max(500),
  filename: z.string().trim().min(1).max(200),
});

const ReorderBody = z.object({
  orderedIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

async function findProposal(proposalId: string) {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, number: true },
  });
  if (!proposal) throw new NotFoundError('Proposal not found');
  return proposal;
}

export function registerProposalRenderingRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };
  const write = { preHandler: requirePermission(Permission.PROPOSAL_WRITE) };

  app.get('/proposals/:proposalId/renderings', read, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    await findProposal(proposalId);
    const rows = await prisma.proposalRendering.findMany({
      where: { proposalId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      configured: isRenderingUploadConfigured(),
      maxBytes: MAX_RENDERING_BYTES,
      accept: Object.keys(ALLOWED_RENDERING_TYPES),
      renderings: rows,
    };
  });

  /** Step 1: mint a scoped client token for one specific upload. */
  app.post('/proposals/:proposalId/renderings/upload-token', write, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    const proposal = await findProposal(proposalId);
    const parsed = UploadTokenBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const { filename, contentType } = parsed.data;

    if (!ALLOWED_RENDERING_TYPES[contentType]) {
      throw new ValidationError(
        `${contentType} is not a file type this accepts. Use a PDF, PNG or JPEG image.`,
      );
    }
    if (!isRenderingUploadConfigured()) {
      throw new ConflictError(
        'File storage is not configured on this deployment, so renderings cannot be uploaded. An administrator needs to set BLOB_READ_WRITE_TOKEN.',
      );
    }

    const fileId = `rnd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const pathname = renderingPath({ proposalNumber: proposal.number, fileId, filename });
    const token = await issueRenderingUploadToken({ pathname, contentType });
    return { token, pathname, maxBytes: MAX_RENDERING_BYTES };
  });

  /** Step 2: the browser's own direct PUT has finished — record it. */
  app.post('/proposals/:proposalId/renderings', write, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    await findProposal(proposalId);
    const parsed = RecordBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const { url, pathname, filename } = parsed.data;

    // Read the file back from blob storage itself rather than trusting what the
    // browser reports about its own upload, and require the path to actually be
    // in the renderings prefix — a client token can only ever write the exact
    // pathname it was issued for, so this rules out a URL for something else
    // entirely (a purchase order, a signed proposal) being reported here.
    const info = await verifyRenderingUpload(url).catch(() => null);
    if (!info) {
      throw new ValidationError(
        'That upload could not be confirmed with the file store. Try again.',
      );
    }
    if (info.pathname !== pathname || !pathname.startsWith('design-renderings/')) {
      throw new ValidationError('That upload does not match the request it was issued for.');
    }

    const maxSort = await prisma.proposalRendering.aggregate({
      where: { proposalId },
      _max: { sortOrder: true },
    });

    const row = await prisma.proposalRendering.create({
      data: {
        proposalId,
        filename: filename.slice(0, 200),
        contentType: info.contentType,
        byteSize: info.size,
        url,
        pathname,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        uploadedById: req.user!.sub,
      },
    });
    return row;
  });

  /** Dense re-sequencing — the whole ordered list, not a single move, so the
   *  UI's drag/up-down result is what gets stored, not a derived guess. */
  app.patch('/proposals/:proposalId/renderings/reorder', write, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    await findProposal(proposalId);
    const parsed = ReorderBody.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');

    const rows = await prisma.proposalRendering.findMany({
      where: { proposalId },
      select: { id: true },
    });
    const known = new Set(rows.map((r) => r.id));
    const ids = parsed.data.orderedIds.filter((id) => known.has(id));
    if (ids.length !== rows.length) {
      throw new ValidationError('The reorder list does not match this proposal’s renderings.');
    }

    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.proposalRendering.update({ where: { id }, data: { sortOrder: i } }),
      ),
    );
    return { ok: true };
  });

  app.delete('/proposals/:proposalId/renderings/:id', write, async (req) => {
    const { proposalId, id } = req.params as { proposalId: string; id: string };
    await findProposal(proposalId);
    const row = await prisma.proposalRendering.findUnique({ where: { id } });
    if (!row || row.proposalId !== proposalId) throw new NotFoundError('Rendering not found');
    await prisma.proposalRendering.delete({ where: { id } });
    await deleteFile(row.url);
    return { ok: true };
  });
}

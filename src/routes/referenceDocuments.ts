import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import {
  MAX_REFERENCE_DOC_BYTES,
  REFERENCE_DOC_CONTENT_TYPE,
  deleteFile,
  getFile,
  isFileStoreConfigured,
  referenceDocumentPath,
  safeSegment,
} from '../lib/fileStore.js';
import { issueDirectUploadToken, verifyRenderingUpload } from '../lib/renderingStore.js';
import { referenceDocumentPages } from '../proposals/referenceDocuments.js';

/**
 * The reference-document library: pre-made PDFs (a W9, a certificate of insurance)
 * kept in the CRM and optionally bound onto a proposal — see the model comment on
 * `ReferenceDocument` in prisma/schema.prisma for why this is a separate thing from
 * LegalDocument rather than the same mechanism.
 *
 * Managing the library is LEGAL_MANAGE, the same permission as the legal documents it
 * sits beside in Administration → Proposal content. Reading the active list is
 * PROPOSAL_READ, because that is what drives the builder's checklist for anyone who
 * can open a proposal.
 */

/** A document key, normalised the same way legal-documents.ts does. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

function keyFrom(title: string): string {
  const key = title
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  // A title that is all digits, all punctuation, or empty (a title in a script with
  // no A-Z/0-9 form at all) fails to start with a letter, which KEY_PATTERN requires
  // — the same rule legal-documents.ts enforces on a hand-typed key.
  return KEY_PATTERN.test(key) ? key : `DOC_${key}`.slice(0, 40).replace(/_+$/, '');
}

async function uniqueKeyFrom(title: string): Promise<string> {
  const base = keyFrom(title);
  let key = base;
  let n = 2;
  // Practically never loops more than once — collisions require two documents
  // whose titles normalise to the same key.
  while (await prisma.referenceDocument.findUnique({ where: { key }, select: { key: true } })) {
    key = `${base}_${n++}`.slice(0, 40);
  }
  return key;
}

const UploadTokenInput = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
});

const RecordInput = z.object({
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(200),
  url: z.string().trim().url(),
  pathname: z.string().trim().min(1).max(500),
});

/**
 * A path the upload-token route could have issued: `reference-documents/<id>-<filename>`
 * with the id shape it mints. The `-pages.json` page cache shares the folder, which is
 * why the id is pinned rather than just the prefix.
 */
const UPLOADED_PATH = /^reference-documents\/(refdoc_[a-z0-9]+)-[^/]+$/;

function summary(row: {
  id: string;
  key: string;
  title: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
}) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * How much page image goes in one `/pages` response. A Vercel function's response
 * stops at ~4.5 MB, and a 23-page product catalog is ~5 MB of images even as JPEG,
 * so the pages come back in batches and the client asks again from `next`.
 */
export const PAGE_BATCH_BYTES = 3 * 1024 * 1024;

/** Pages from `from` until the next would pass PAGE_BATCH_BYTES — always at least one. */
export function pageBatch<T extends { dataUri: string }>(pages: T[], from: number) {
  const start = Math.max(0, Math.min(Math.floor(from), pages.length));
  const batch: T[] = [];
  let bytes = 0;
  for (let i = start; i < pages.length; i++) {
    const page = pages[i]!;
    if (batch.length && bytes + page.dataUri.length > PAGE_BATCH_BYTES) break;
    batch.push(page);
    bytes += page.dataUri.length;
  }
  const end = start + batch.length;
  return { pages: batch, total: pages.length, next: end < pages.length ? end : null };
}

export function registerReferenceDocumentRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.LEGAL_MANAGE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /** Every document, for the admin list. */
  app.get('/reference-documents', manage, async () => {
    const rows = await prisma.referenceDocument.findMany({
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
    return rows.map(summary);
  });

  /**
   * Active documents only, for the proposal builder's checklist — same shape
   * `/legal-documents/effective` takes for the contract-documents checklist.
   */
  app.get('/reference-documents/active', read, async () => {
    const rows = await prisma.referenceDocument.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      select: { key: true, title: true, filename: true, byteSize: true },
    });
    return { documents: rows };
  });

  /**
   * Upload a document, step 1: a token the browser can use to PUT exactly this PDF,
   * at exactly this path, straight to blob storage.
   *
   * Browser-to-blob, the same two-step shape as design renderings and BOM files (see
   * lib/renderingStore.ts). This used to be base64 in a JSON body, and base64 inflates
   * by a third: a 4 MB product catalog became a 5.3 MB request, past the ~4.5 MB
   * Vercel accepts as a function's body, so Vercel refused it before this app saw it —
   * well inside the MAX_REFERENCE_DOC_BYTES this route claimed to allow.
   *
   * PDF only. See the type comment on REFERENCE_DOC_CONTENT_TYPE: this file is merged
   * in as real pages elsewhere, which only makes sense for another PDF.
   */
  app.post('/reference-documents/upload-token', manage, async (req) => {
    const parsed = UploadTokenInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid upload');
    }
    const contentType = parsed.data.contentType.split(';')[0]!.trim().toLowerCase();
    if (contentType !== REFERENCE_DOC_CONTENT_TYPE) {
      throw new ValidationError('Only a PDF can be uploaded here.');
    }
    if (!isFileStoreConfigured()) {
      throw new ConflictError(
        'File storage is not configured on this deployment, so the document cannot be kept. An administrator needs to set BLOB_READ_WRITE_TOKEN.',
      );
    }
    const id = `refdoc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const pathname = referenceDocumentPath({ fileId: id, filename: parsed.data.filename });
    const token = await issueDirectUploadToken({
      pathname,
      contentType,
      maxBytes: MAX_REFERENCE_DOC_BYTES,
    });
    return { token, pathname, contentType, maxBytes: MAX_REFERENCE_DOC_BYTES };
  });

  /**
   * Step 2: the browser's own PUT has finished — record it. Size and type are read
   * back from blob storage rather than taken from the browser, and the path must be
   * one step 1 could have issued, so this cannot record some other stored file (a
   * purchase order, this library's own page cache) as a reference document.
   */
  app.post('/reference-documents', manage, async (req) => {
    const parsed = RecordInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid upload');
    }
    const d = parsed.data;
    const id = UPLOADED_PATH.exec(d.pathname)?.[1];
    if (!id) {
      throw new ValidationError('That upload does not match the request it was issued for.');
    }
    const info = await verifyRenderingUpload(d.url).catch(() => null);
    if (!info) {
      throw new ValidationError(
        'That upload could not be confirmed with the file store. Try again.',
      );
    }
    if (info.pathname !== d.pathname) {
      throw new ValidationError('That upload does not match the request it was issued for.');
    }
    const contentType = info.contentType.split(';')[0]!.trim().toLowerCase();
    if (contentType !== REFERENCE_DOC_CONTENT_TYPE) {
      throw new ValidationError('Only a PDF can be uploaded here.');
    }
    if (!info.size) throw new ValidationError('That file is empty.');
    if (info.size > MAX_REFERENCE_DOC_BYTES) {
      throw new ValidationError(
        `That file is ${(info.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_REFERENCE_DOC_BYTES / 1024 / 1024} MB.`,
      );
    }

    const key = await uniqueKeyFrom(d.title);
    const last = await prisma.referenceDocument.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.referenceDocument.create({
      data: {
        id,
        key,
        title: d.title,
        filename: safeSegment(d.filename, 'document'),
        contentType,
        byteSize: info.size,
        // The store's canonical URL from head(), not the one the browser reported.
        url: info.url,
        pathname: info.pathname,
        sortOrder: (last._max.sortOrder ?? 0) + 10,
        uploadedById: req.user!.sub,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'referenceDocument.upload',
      entity: 'ReferenceDocument',
      entityId: row.id,
      details: { title: row.title, filename: row.filename, bytes: row.byteSize },
    });

    return summary(row);
  });

  /** Rename, retire/reinstate, or nudge the print order. */
  app.patch<{ Params: { id: string } }>('/reference-documents/:id', manage, async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(100000).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid edit');
    const existing = await prisma.referenceDocument.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError('That document was not found');

    const row = await prisma.referenceDocument.update({
      where: { id: req.params.id },
      data: body.data,
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'referenceDocument.update',
      entity: 'ReferenceDocument',
      entityId: row.id,
      details: body.data,
    });
    return summary(row);
  });

  /**
   * Remove a document.
   *
   * Unlike a legal document, there is no wording here that a released proposal's
   * snapshot needs to keep explaining — this is a current, standalone file (a W9 is
   * simply current or it is not). Deletion is unconditional, matching
   * CustomerPurchaseOrderFile: row first, blob second, so an orphaned blob is
   * housekeeping rather than a download that 500s.
   */
  app.delete<{ Params: { id: string } }>('/reference-documents/:id', manage, async (req) => {
    const row = await prisma.referenceDocument.findUnique({ where: { id: req.params.id } });
    if (!row) throw new NotFoundError('That document was not found');
    await prisma.referenceDocument.delete({ where: { id: row.id } });
    await deleteFile(row.url);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'referenceDocument.delete',
      entity: 'ReferenceDocument',
      entityId: row.id,
      details: { title: row.title },
    });
    return { ok: true };
  });

  /**
   * A reference document's pages, pre-rendered to PNGs — read-permission gated
   * like `/reference-documents/active`, because this is what the proposal
   * preview/print pipeline (public/app.js) needs for anyone who can open a
   * proposal, not just Administration. Keyed by `key` (what a proposal's saved
   * selection actually stores), not `id`.
   *
   * Empty `pages` covers "no such key", "retired", and "could not be
   * rendered" alike — see referenceDocumentPages' own comment for why that is
   * deliberate rather than a 404: a broken reference document should silently
   * drop out of a proposal preview, not break it.
   */
  app.get<{ Params: { key: string }; Querystring: { from?: string } }>(
    '/reference-documents/:key/pages',
    read,
    async (req) => {
      const all = await referenceDocumentPages(req.params.key);
      return { key: req.params.key, ...pageBatch(all, Number(req.query.from) || 0) };
    },
  );

  /** Proxied, not redirected to the blob URL — same reasoning as the purchase-order download: CSP and not handing a public URL to the browser. */
  app.get<{ Params: { id: string } }>(
    '/reference-documents/:id/download',
    manage,
    async (req, reply) => {
      const row = await prisma.referenceDocument.findUnique({ where: { id: req.params.id } });
      if (!row) throw new NotFoundError('That document was not found');
      const bytes = await getFile(row.url);
      return reply
        .header('Content-Type', row.contentType)
        .header('Content-Disposition', `inline; filename="${row.filename}"`)
        .header('Cache-Control', 'private, max-age=60')
        .send(bytes);
    },
  );
}

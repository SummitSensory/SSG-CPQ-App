import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/errors.js';
import {
  MAX_REFERENCE_DOC_BYTES,
  REFERENCE_DOC_CONTENT_TYPE,
  deleteFile,
  getFile,
  isFileStoreConfigured,
  putFile,
  referenceDocumentPath,
  referenceDocumentPagePath,
  safeSegment,
} from '../lib/fileStore.js';
import { pdfRasterAvailable, rasterizePdfPages } from '../render/pdfRaster.js';

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

const UploadInput = z.object({
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  base64: z.string().min(1),
});

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

interface StoredPageImage {
  pathname: string;
  url: string;
  width: number;
  height: number;
}

function parseStoredPages(value: unknown): StoredPageImage[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: StoredPageImage[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).url !== 'string' ||
      typeof (item as Record<string, unknown>).pathname !== 'string' ||
      typeof (item as Record<string, unknown>).width !== 'number' ||
      typeof (item as Record<string, unknown>).height !== 'number'
    ) {
      return null;
    }
    out.push(item as unknown as StoredPageImage);
  }
  return out;
}

/**
 * A reference document's pages, as data URIs ready to embed in an `<img src>` — the
 * proposal preview and the standalone document sent for PDF rendering are both
 * self-contained HTML with no fetch of their own, the same rule render/pdf.ts's own
 * doc comment states for every image in that pipeline.
 *
 * Cached in ReferenceDocument.pageImages after the first render (see the model
 * comment); every call after that only re-reads the cached PNGs from blob storage
 * rather than re-rasterizing. Never throws — a document that fails to render (a
 * corrupt upload, rasterization unavailable on this deployment) logs and returns no
 * pages, so one bad reference document cannot break the rest of a proposal's preview.
 */
async function pagesFor(row: {
  id: string;
  key: string;
  url: string;
  pageImages: unknown;
}): Promise<string[]> {
  const cached = parseStoredPages(row.pageImages);
  if (cached) {
    try {
      const pages = await Promise.all(
        cached.map(async (p) => {
          const bytes = await getFile(p.url);
          return `data:image/png;base64,${bytes.toString('base64')}`;
        }),
      );
      return pages;
    } catch (err) {
      logger.warn(
        { err, key: row.key },
        'referenceDocuments: could not read cached page images, re-rendering',
      );
      // Fall through and re-render below.
    }
  }

  if (!(await pdfRasterAvailable())) return [];

  let rendered;
  try {
    const bytes = await getFile(row.url);
    rendered = await rasterizePdfPages(bytes);
  } catch (err) {
    logger.error({ err, key: row.key }, 'referenceDocuments: could not rasterize document');
    return [];
  }
  if (!rendered.length) return [];

  const dataUris = rendered.map((p) => `data:image/png;base64,${p.png.toString('base64')}`);

  // Best-effort cache write. A failure here (store not configured, one upload fails)
  // just means the next preview re-renders — it must not fail a preview that already
  // has its images in hand.
  if (isFileStoreConfigured()) {
    try {
      const stored: StoredPageImage[] = [];
      for (let i = 0; i < rendered.length; i++) {
        const page = rendered[i]!;
        const path = referenceDocumentPagePath({ fileId: row.id, page: i + 1 });
        const up = await putFile(path, page.png, 'image/png');
        stored.push({ pathname: up.pathname, url: up.url, width: page.width, height: page.height });
      }
      await prisma.referenceDocument.update({
        where: { id: row.id },
        data: { pageImages: stored as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      logger.warn(
        { err, key: row.key },
        'referenceDocuments: could not cache rendered page images',
      );
    }
  }

  return dataUris;
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
   * Page images for a set of selected documents, for the proposal preview overlay and
   * the browser's own Print / Save PDF — see pagesFor's doc comment and
   * src/render/pdfRaster.ts for why a PDF page becomes an image here rather than a
   * real merged PDF page (the emailed/e-signed copy takes that route instead, via
   * resolveReferenceDocuments + appendPdfDocuments).
   *
   * `?keys=A,B,C`, comma-separated, capped and de-duplicated. Returned in the
   * library's own print order — the same `sortOrder` then `title` order
   * resolveReferenceDocuments uses — so the preview and the emailed copy agree on
   * sequence. A key that does not resolve to an active document (retired, deleted,
   * or simply wrong) drops out silently rather than erroring, the same rule
   * resolveReferenceDocuments applies: a document retired after a proposal selected
   * it should not break that proposal's preview.
   */
  app.get<{ Querystring: { keys?: string } }>('/reference-documents/pages', read, async (req) => {
    const keys = Array.from(
      new Set(
        String(req.query.keys || '')
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ).slice(0, 25);
    if (!keys.length) return { documents: [] };

    const rows = await prisma.referenceDocument.findMany({
      where: { key: { in: keys }, active: true },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });

    const documents: Array<{ key: string; title: string; pages: string[] }> = [];
    for (const row of rows) {
      documents.push({ key: row.key, title: row.title, pages: await pagesFor(row) });
    }
    return { documents };
  });

  /**
   * Upload a document. Base64 in a JSON body, not multipart — same reasoning as the
   * purchase-order upload this mirrors: the app registers no multipart parser, and
   * one for occasional staff uploads is a dependency for no gain.
   *
   * PDF only. See the type comment on REFERENCE_DOC_CONTENT_TYPE: this file is merged
   * in as real pages elsewhere, which only makes sense for another PDF.
   */
  app.post('/reference-documents', manage, async (req) => {
    const parsed = UploadInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid upload');
    }
    const d = parsed.data;
    const contentType = d.contentType.split(';')[0]!.trim().toLowerCase();
    if (contentType !== REFERENCE_DOC_CONTENT_TYPE) {
      throw new ValidationError('Only a PDF can be uploaded here.');
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(d.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch {
      throw new ValidationError('That file could not be read.');
    }
    if (!bytes.length) throw new ValidationError('That file is empty.');
    if (bytes.length > MAX_REFERENCE_DOC_BYTES) {
      throw new ValidationError(
        `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_REFERENCE_DOC_BYTES / 1024 / 1024} MB.`,
      );
    }
    if (!isFileStoreConfigured()) {
      throw new ConflictError(
        'File storage is not configured on this deployment, so the document cannot be kept. An administrator needs to set BLOB_READ_WRITE_TOKEN.',
      );
    }

    const key = await uniqueKeyFrom(d.title);
    const id = `refdoc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const stored = await putFile(
      referenceDocumentPath({ fileId: id, filename: d.filename }),
      bytes,
      contentType,
    );

    const last = await prisma.referenceDocument.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.referenceDocument.create({
      data: {
        id,
        key,
        title: d.title,
        filename: safeSegment(d.filename, 'document'),
        contentType,
        byteSize: stored.bytes,
        url: stored.url,
        pathname: stored.pathname,
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

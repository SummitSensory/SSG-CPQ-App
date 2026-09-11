import { prisma } from '../lib/prisma.js';
import { getFile, putFile, isFileStoreConfigured } from '../lib/fileStore.js';
import { rasterizePdfPages, type RasterPage } from '../lib/pdfRaster.js';
import { logger } from '../lib/logger.js';
import { metaOf } from './analytics.js';

/**
 * Which reference-document keys a proposal's saved meta selected — read from the
 * version's own stored `sections`, not from anything a request claims, for the same
 * reason `checkDocumentTotal` re-derives the total from the saved version rather than
 * trusting the caller: what actually merges into a customer-facing PDF has to come
 * from what was saved through the ordinary builder save path.
 */
export function selectedReferenceDocKeys(sections: unknown): string[] {
  const meta = metaOf(sections) as { referenceDocKeys?: unknown };
  return Array.isArray(meta.referenceDocKeys)
    ? meta.referenceDocKeys.filter((k): k is string => typeof k === 'string')
    : [];
}

/**
 * The actual PDF bytes for a set of selected reference-document keys, in the
 * library's own print order.
 *
 * Filtered to `active` — a document retired in Administration after a proposal
 * selected it drops out silently, the same rule LegalDocument uses for a disabled
 * document: retiring it stops it from going out on anything new.
 */
export async function resolveReferenceDocuments(
  keys: string[],
): Promise<Array<{ name: string; bytes: Buffer }>> {
  if (!keys.length) return [];
  const rows = await prisma.referenceDocument.findMany({
    where: { key: { in: keys }, active: true },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
  });
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (const row of rows) {
    out.push({ name: row.filename, bytes: await getFile(row.url) });
  }
  return out;
}

interface PagesManifest {
  pages: RasterPage[];
}

/**
 * The rasterized pages (one PNG per PDF page) for a single active reference
 * document — what the client-side proposal preview and print pipeline inserts
 * as extra "sheets" (see public/app.js's paginateProposalArea /
 * proposalStandaloneHtml), since that pipeline is pure HTML with no mechanism
 * of its own for merging real PDF pages.
 *
 * Rendered once and cached in the same blob store as the document's own file
 * (ReferenceDocument.pagesUrl/pagesPathname) — a document's content is
 * immutable once uploaded (there is no "replace file" route, only upload-anew,
 * which mints a new id and key), so the cache never needs invalidating for the
 * life of the row. Every failure mode here (no row, retired, corrupt PDF, blob
 * store down) returns an empty array rather than throwing: a broken reference
 * document must not be the reason a proposal preview fails to render, the same
 * "silently drop it" rule resolveReferenceDocuments already applies to a
 * retired document.
 */
export async function referenceDocumentPages(key: string): Promise<RasterPage[]> {
  const row = await prisma.referenceDocument.findUnique({ where: { key } });
  if (!row || !row.active) return [];

  if (row.pagesUrl) {
    try {
      const cached = await getFile(row.pagesUrl);
      const manifest = JSON.parse(cached.toString('utf8')) as PagesManifest;
      if (Array.isArray(manifest.pages) && manifest.pages.length) return manifest.pages;
    } catch (err) {
      logger.warn(
        { err, key },
        'referenceDocumentPages: cached page manifest unreadable, re-rendering',
      );
    }
  }

  let pages: RasterPage[];
  try {
    pages = await rasterizePdfPages(await getFile(row.url));
  } catch (err) {
    logger.error({ err, key }, 'referenceDocumentPages: could not rasterize the document');
    return [];
  }
  if (!pages.length) return pages;

  // Best-effort: a cache-write failure must not stop the preview from showing
  // the pages this render just produced — it only means the next preview pays
  // to render them again.
  if (isFileStoreConfigured()) {
    try {
      const stored = await putFile(
        `reference-documents/${row.id}-pages.json`,
        Buffer.from(JSON.stringify({ pages } satisfies PagesManifest)),
        'application/json',
      );
      await prisma.referenceDocument.update({
        where: { id: row.id },
        data: { pagesUrl: stored.url, pagesPathname: stored.pathname },
      });
    } catch (err) {
      logger.warn({ err, key }, 'referenceDocumentPages: could not cache the rendered pages');
    }
  }
  return pages;
}

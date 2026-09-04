import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { head as blobHead } from '@vercel/blob';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { safeSegment, getFile } from './fileStore.js';

/**
 * Design renderings — CAD exports, photorealistic renders, scanned drawings —
 * routinely run well past the 3 MB ceiling lib/fileStore.ts enforces for a
 * purchase order, and past the ~4.5 MB body limit Vercel puts on a serverless
 * function's request regardless of what this app's own `bodyLimit` says. There is
 * no encoding trick around a platform limit: the bytes cannot go through our
 * Fastify server at all.
 *
 * So this is the one upload path in the app that goes browser-to-blob directly.
 * The server only ever handles two small JSON calls: mint a short-lived, scoped
 * client token (this file), and record the resulting metadata once the browser's
 * own PUT to blob storage has finished (routes/proposalRenderings.ts). The actual
 * upload — and the wire protocol for it — is Vercel's own client SDK, bundled for
 * the browser by scripts/build-blob-client.mjs into public/vendor. That protocol
 * (store-id headers, presigned vs. bearer auth) is materially more involved than
 * the plain PUT putFile() makes with a full read-write token, and hand-rolling it
 * from a decompiled bundle is exactly the kind of guess that produced the
 * x-vercel-blob-access bug earlier in this project's history — better to ship the
 * real client than reverse-engineer it.
 */

/** 250 MB. Comfortably past "bigger than 40MB" with headroom for a large CAD export. */
export const MAX_RENDERING_BYTES = 250 * 1024 * 1024;

/**
 * PDF, PNG and JPEG only — not the wider image set lib/fileStore.ts accepts for a
 * purchase order. A rendering has to be embeddable as a page in the sent
 * document (pdfMerge.ts's appendImagePages), and pdf-lib only embeds those two
 * raster formats; a TIFF or HEIC upload would store fine but silently fail to
 * appear in anything sent, which is worse than not offering it.
 */
export const ALLOWED_RENDERING_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export function isRenderingUploadConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

/** `design-renderings/<proposal number>/<id>-<filename>`. */
export function renderingPath(input: {
  proposalNumber: string;
  fileId: string;
  filename: string;
}): string {
  return `design-renderings/${safeSegment(input.proposalNumber, 'proposal')}/${input.fileId}-${safeSegment(
    input.filename,
  )}`;
}

/**
 * A token the browser can use to PUT one specific file, of one specific content
 * type, up to one specific size, straight to blob storage — none of which the
 * browser can widen, since they're encoded into the signed token itself rather
 * than merely suggested by request headers.
 */
export async function issueRenderingUploadToken(input: {
  pathname: string;
  contentType: string;
}): Promise<string> {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('File storage is not configured on this deployment (BLOB_READ_WRITE_TOKEN).');
  }
  return generateClientTokenFromReadWriteToken({
    token: env.BLOB_READ_WRITE_TOKEN,
    pathname: input.pathname,
    allowedContentTypes: [input.contentType],
    maximumSizeInBytes: MAX_RENDERING_BYTES,
    addRandomSuffix: false,
    // A minute is generous for a click-to-upload-start gap and stingy enough that
    // a leaked token is useless soon after.
    validUntil: Date.now() + 60_000,
  });
}

/**
 * Confirm the browser's direct upload actually landed where the token said it
 * would, and read back the authoritative size/content-type from blob storage
 * itself rather than trusting whatever the browser reports about its own upload.
 */
export async function verifyRenderingUpload(
  url: string,
): Promise<{ size: number; contentType: string; pathname: string }> {
  const result = await blobHead(url, { token: env.BLOB_READ_WRITE_TOKEN });
  return { size: result.size, contentType: result.contentType, pathname: result.pathname };
}

export interface ResolvedRendering {
  id: string;
  name: string;
  bytes: Buffer;
  contentType: string;
}

/**
 * Fetch renderings for binding into a sent document, in the order given rather
 * than stored sortOrder — the caller decides page order at send time. Ids not
 * belonging to this proposal are silently dropped, the same "compose what goes
 * out" trust boundary as resolveAttachments: a stale id from a slow client is a
 * mis-send worth ignoring rather than blocking on.
 *
 * A rendering that fails to fetch is dropped rather than failing the whole
 * send — logged, not silent — matching how appendPdfDocuments/appendImagePages
 * already treat a document that fails to merge: a signature request should not
 * be blocked by one broken attachment.
 */
export async function resolveRenderings(
  proposalId: string,
  renderingIds: string[],
): Promise<ResolvedRendering[]> {
  if (!renderingIds.length) return [];
  const rows = await prisma.proposalRendering.findMany({
    where: { proposalId, id: { in: renderingIds } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = renderingIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r));

  const resolved: ResolvedRendering[] = [];
  for (const row of ordered) {
    try {
      const bytes = await getFile(row.url);
      resolved.push({ id: row.id, name: row.filename, bytes, contentType: row.contentType });
    } catch (err) {
      logger.error(
        { err, renderingId: row.id },
        'renderingStore: could not fetch rendering for send',
      );
    }
  }
  return resolved;
}

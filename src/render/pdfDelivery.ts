import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { deleteFile, getFile, isBlobStoreUrl, putFile, safeSegment } from '../lib/fileStore.js';

/**
 * Getting a rendered PDF bigger than a Vercel function's response back to the browser.
 *
 * A function's response stops at ~4.5 MB. A proposal on its own is well under that,
 * but one with a product catalog attached as a reference document is not (a 4 MB,
 * 23-page catalog alone merges to 3.7 MB), and Save PDF and Print then failed with
 * nothing to show for it but the browser-print fallback.
 *
 * So a PDF past INLINE_PDF_MAX_BYTES is parked in the private blob store and the
 * browser reads it back in parts, each a response of its own under the limit. Through
 * this server rather than a presigned link straight to storage, because Print needs
 * the bytes in the page (a blob: URL in a frame) and a cross-origin fetch of the store
 * is at the mercy of its CORS and the app's connect-src.
 *
 * The browser is handed a signed ticket naming the stored file, never a URL it could
 * swap for another: the parts route reads only what a ticket this server signed names,
 * and only until it expires.
 */

/** Under the ~4.5 MB ceiling with room for headers. */
export const INLINE_PDF_MAX_BYTES = 4 * 1024 * 1024;

/** One part of a parked PDF. */
export const PDF_PART_BYTES = 3 * 1024 * 1024;

/** Long enough to read every part; short enough that a leaked ticket is soon useless. */
const TICKET_TTL_MS = 10 * 60_000;

interface Ticket {
  u: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`pdf-part:${payload}`)
    .digest('base64url');
}

export function issueTicket(url: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: url, exp: now + TICKET_TTL_MS } satisfies Ticket),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The stored file's URL, or null for a ticket this server did not sign or that has expired. */
export function readTicket(ticket: string, now = Date.now()): string | null {
  const [payload, mac] = ticket.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let t: Partial<Ticket>;
  try {
    t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Ticket>;
  } catch {
    return null;
  }
  if (typeof t.u !== 'string' || typeof t.exp !== 'number' || t.exp < now) return null;
  return isBlobStoreUrl(t.u) ? t.u : null;
}

/** Park a PDF too big to return directly. */
export async function parkPdf(
  pdf: Buffer,
  name: string,
): Promise<{ ticket: string; bytes: number; parts: number }> {
  const id = randomBytes(12).toString('hex');
  const stored = await putFile(
    `rendered-pdfs/${id}-${safeSegment(name, 'document')}.pdf`,
    pdf,
    'application/pdf',
  );
  return {
    ticket: issueTicket(stored.url),
    bytes: pdf.length,
    parts: Math.ceil(pdf.length / PDF_PART_BYTES),
  };
}

/**
 * One part of a parked PDF. The parked copy is deleted once its last part has been
 * read — it exists only to get this one download across — so a copy is left behind
 * only by a download abandoned partway through.
 */
export async function readPdfPart(url: string, part: number): Promise<Buffer | null> {
  const all = await getFile(url);
  const start = part * PDF_PART_BYTES;
  if (!Number.isInteger(part) || part < 0 || start >= all.length) return null;
  const end = Math.min(start + PDF_PART_BYTES, all.length);
  if (end === all.length) await deleteFile(url);
  return all.subarray(start, end);
}

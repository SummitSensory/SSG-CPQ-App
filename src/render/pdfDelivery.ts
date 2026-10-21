import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { del as blobDel, get as blobGet } from '@vercel/blob';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { putFile } from '../lib/fileStore.js';

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
 * The browser is handed a signed, expiring ticket carrying only a random id — never a
 * URL or a path. The parts route reads `rendered-pdfs/<id>.pdf` and nothing else, so
 * no ticket, signed or not, can point it at another stored file.
 */

/** Under the ~4.5 MB ceiling with room for headers. */
export const INLINE_PDF_MAX_BYTES = 4 * 1024 * 1024;

/** One part of a parked PDF. */
export const PDF_PART_BYTES = 3 * 1024 * 1024;

/** Long enough to read every part; short enough that a leaked ticket is soon useless. */
const TICKET_TTL_MS = 10 * 60_000;

const ID_PATTERN = /^[a-f0-9]{24}$/;

function parkedPath(id: string): string {
  return `rendered-pdfs/${id}.pdf`;
}

interface Ticket {
  id: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`pdf-part:${payload}`)
    .digest('base64url');
}

export function issueTicket(id: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ id, exp: now + TICKET_TTL_MS } satisfies Ticket),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The parked file's id, or null for a ticket this server did not sign or that has expired. */
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
  if (typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) return null;
  if (typeof t.exp !== 'number' || t.exp < now) return null;
  return t.id;
}

/** Park a PDF too big to return directly. */
export async function parkPdf(
  pdf: Buffer,
): Promise<{ ticket: string; bytes: number; parts: number }> {
  const id = randomBytes(12).toString('hex');
  await putFile(parkedPath(id), pdf, 'application/pdf');
  return {
    ticket: issueTicket(id),
    bytes: pdf.length,
    parts: Math.ceil(pdf.length / PDF_PART_BYTES),
  };
}

/**
 * One part of a parked PDF, or null when there is no such part. The parked copy is
 * deleted once its last part has been read — it exists only to get this one download
 * across — so a copy is left behind only by a download abandoned partway through.
 */
export async function readPdfPart(id: string, part: number): Promise<Buffer | null> {
  if (!ID_PATTERN.test(id) || !Number.isInteger(part) || part < 0) return null;
  const pathname = parkedPath(id);
  const r = await blobGet(pathname, { access: 'private', token: env.BLOB_READ_WRITE_TOKEN });
  if (!r || r.statusCode !== 200) return null;
  const all = Buffer.from(await new Response(r.stream).arrayBuffer());
  const start = part * PDF_PART_BYTES;
  if (start >= all.length) return null;
  const end = Math.min(start + PDF_PART_BYTES, all.length);
  if (end === all.length) {
    await blobDel(pathname, { token: env.BLOB_READ_WRITE_TOKEN }).catch((err: unknown) => {
      logger.warn({ err }, 'pdfDelivery: could not delete a parked PDF');
    });
  }
  return all.subarray(start, end);
}

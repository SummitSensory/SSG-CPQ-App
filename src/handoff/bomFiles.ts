import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import { safeSegment, getFile, deleteFile } from '../lib/fileStore.js';
import {
  isRenderingUploadConfigured,
  issueDirectUploadToken,
  verifyRenderingUpload,
} from '../lib/renderingStore.js';

/**
 * Files uploaded against one vendor's Bill of Materials — a drawing, a spec sheet,
 * a finish sample — that the sender can tick to go out with the BOM email.
 *
 * Uploaded browser-to-blob directly, the same way design renderings are (see
 * lib/renderingStore.ts): a fabrication drawing routinely runs past the ~4.5 MB a
 * Vercel function will accept as a request body, so the bytes never pass through
 * this server on the way in. They do on the way out — the email provider takes
 * attachments inline — which is what the send-time total below is for.
 */

/** Per file. Well inside the email ceiling below, so one file can always go. */
export const MAX_BOM_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Everything attached to one email, the BOM's own PDF/Excel included. Resend
 * refuses a message over 40 MB after base64 encoding, which inflates by a third;
 * 28 MB of raw bytes leaves room for the encoding and the message itself.
 */
export const MAX_BOM_EMAIL_ATTACHMENT_BYTES = 28 * 1024 * 1024;

/**
 * Keyed by extension rather than trusting the browser's MIME type: a browser
 * reports an empty type for a .dwg or .step file, and the type sent to the store
 * is what the vendor's mail client opens the attachment with.
 */
export const ALLOWED_BOM_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  step: 'model/step',
  stp: 'model/step',
  igs: 'model/iges',
  iges: 'model/iges',
  stl: 'model/stl',
};

const PATH_PREFIX = 'bom-files/';

export function bomFileContentType(filename: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename.trim())?.[1]?.toLowerCase();
  return (ext && ALLOWED_BOM_FILE_TYPES[ext]) || null;
}

/** `bom-files/<order number>/<vendor>/<id>-<filename>`. */
export function bomFilePath(input: {
  orderNumber: string;
  vendor: string;
  fileId: string;
  filename: string;
}): string {
  return `${PATH_PREFIX}${safeSegment(input.orderNumber, 'order')}/${safeSegment(
    input.vendor,
    'vendor',
  )}/${input.fileId}-${safeSegment(input.filename)}`;
}

export function bomFileUploadSettings() {
  return {
    configured: isRenderingUploadConfigured(),
    maxBytes: MAX_BOM_FILE_BYTES,
    maxEmailBytes: MAX_BOM_EMAIL_ATTACHMENT_BYTES,
    accept: Object.keys(ALLOWED_BOM_FILE_TYPES).map((e) => `.${e}`),
  };
}

async function findSection(sectionId: string) {
  const section = await prisma.bomVendorSection.findUnique({
    where: { id: sectionId },
    select: { id: true, orderId: true, vendor: true, order: { select: { number: true } } },
  });
  if (!section) throw new NotFoundError('Bill of Materials section not found');
  return section;
}

/**
 * Step 1 of an upload: a token the browser can use to PUT exactly this file, at
 * exactly this path, straight to blob storage.
 */
export async function issueBomFileUploadToken(sectionId: string, filename: string) {
  const section = await findSection(sectionId);
  const contentType = bomFileContentType(filename);
  if (!contentType) {
    throw new ValidationError(
      `“${filename}” is not a file type this accepts. Use a PDF, an image, an Office document, a CSV, a ZIP or a CAD file (DWG, DXF, STEP, IGES, STL).`,
    );
  }
  if (!isRenderingUploadConfigured()) {
    throw new ConflictError(
      'File storage is not configured on this deployment, so files cannot be uploaded. An administrator needs to set BLOB_READ_WRITE_TOKEN.',
    );
  }
  const fileId = `bomf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const pathname = bomFilePath({
    orderNumber: section.order.number,
    vendor: section.vendor,
    fileId,
    filename,
  });
  const token = await issueDirectUploadToken({
    pathname,
    contentType,
    maxBytes: MAX_BOM_FILE_BYTES,
  });
  return { token, pathname, contentType, maxBytes: MAX_BOM_FILE_BYTES };
}

/**
 * Step 2: the browser's own PUT has finished. The size and type are read back
 * from blob storage rather than taken from the browser, and the path has to be in
 * this section's own folder — a token only writes the exact path it was issued
 * for, so this rules out recording some other stored document (a customer's
 * purchase order) as a vendor attachment.
 */
export async function recordBomFile(
  sectionId: string,
  input: { url: string; pathname: string; filename: string },
  actorId: string,
) {
  const section = await findSection(sectionId);
  const info = await verifyRenderingUpload(input.url).catch(() => null);
  if (!info) {
    throw new ValidationError('That upload could not be confirmed with the file store. Try again.');
  }
  const folder = `${PATH_PREFIX}${safeSegment(section.order.number, 'order')}/${safeSegment(
    section.vendor,
    'vendor',
  )}/`;
  if (info.pathname !== input.pathname || !input.pathname.startsWith(folder)) {
    throw new ValidationError('That upload does not match the request it was issued for.');
  }
  const row = await prisma.bomSectionFile.create({
    data: {
      sectionId,
      orderId: section.orderId,
      filename: input.filename.slice(0, 200),
      contentType: info.contentType,
      byteSize: info.size,
      url: input.url,
      pathname: input.pathname,
      uploadedById: actorId,
    },
  });
  await prisma.orderEvent.create({
    data: {
      orderId: section.orderId,
      action: 'bom.file.uploaded',
      actorId,
      detail: { vendor: section.vendor, filename: row.filename, byteSize: row.byteSize },
    },
  });
  const uploader = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
  return fileView(row, new Map([[actorId, uploader?.name ?? null]]));
}

type FileRow = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  uploadedById: string;
  createdAt: Date;
};

/** What the browser sees. The blob URL stays server-side: the store is private. */
export function fileView(row: FileRow, nameById: ReadonlyMap<string, string | null>) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    uploadedBy: nameById.get(row.uploadedById) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listBomFiles(sectionId: string) {
  await findSection(sectionId);
  const rows = await prisma.bomSectionFile.findMany({
    where: { sectionId },
    orderBy: { createdAt: 'asc' },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.uploadedById))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map<string, string | null>(users.map((u) => [u.id, u.name]));
  return rows.map((r) => fileView(r, nameById));
}

async function findFile(sectionId: string, fileId: string) {
  const row = await prisma.bomSectionFile.findUnique({ where: { id: fileId } });
  if (!row || row.sectionId !== sectionId) throw new NotFoundError('File not found');
  return row;
}

/** The bytes, for the download link on the section. */
export async function downloadBomFile(sectionId: string, fileId: string) {
  const row = await findFile(sectionId, fileId);
  const bytes = await getFile(row.url);
  return { filename: row.filename, contentType: row.contentType, bytes };
}

/**
 * Removing a file never touches a send that already carried it — BomSend keeps
 * its own copy of the filenames. It only stops the file being offered next time.
 */
export async function deleteBomFile(sectionId: string, fileId: string, actorId: string) {
  const row = await findFile(sectionId, fileId);
  await prisma.bomSectionFile.delete({ where: { id: row.id } });
  await deleteFile(row.url);
  await prisma.orderEvent.create({
    data: {
      orderId: row.orderId,
      action: 'bom.file.removed',
      actorId,
      detail: { filename: row.filename },
    },
  });
}

export interface ResolvedBomFile {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  bytes: Buffer;
}

/**
 * The files the sender ticked, read back for attaching. Strict, unlike the
 * proposal's renderings: a vendor email that silently drops the drawing the
 * sender chose is worse than one that does not go, so an id that is not this
 * section's, or a file that cannot be read, stops the send.
 */
export async function resolveBomFilesForSend(
  sectionId: string,
  fileIds: string[],
): Promise<ResolvedBomFile[]> {
  const ids = [...new Set(fileIds)];
  if (!ids.length) return [];
  const rows = await prisma.bomSectionFile.findMany({ where: { sectionId, id: { in: ids } } });
  if (rows.length !== ids.length) {
    throw new ValidationError(
      'One of the files you ticked is no longer on this Bill of Materials. Close the dialog, reopen it and try again. Nothing was sent.',
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ResolvedBomFile[] = [];
  for (const id of ids) {
    const row = byId.get(id)!;
    let bytes: Buffer;
    try {
      bytes = await getFile(row.url);
    } catch {
      throw new ValidationError(
        `Could not read “${row.filename}” from file storage. Nothing was sent.`,
      );
    }
    out.push({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      byteSize: bytes.length,
      bytes,
    });
  }
  return out;
}

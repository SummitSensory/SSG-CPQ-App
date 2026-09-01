import { prisma } from '../lib/prisma.js';
import { getFile } from '../lib/fileStore.js';
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

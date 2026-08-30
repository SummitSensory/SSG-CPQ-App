import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  LEGAL_KEYS,
  defaultContent,
  type LegalDocumentContent,
  type LegalKey,
} from './defaults.js';

/**
 * Reading, publishing and freezing the two legal documents.
 *
 * The rule this file exists to enforce
 * ------------------------------------
 * The terms themselves say it: "The version of these Terms provided with or incorporated
 * into the accepted proposal or order governs that transaction." So the software must be
 * able to answer, for any released proposal, what the customer was actually shown — not
 * what the terms happen to say today.
 *
 * It does that the same way the rest of this codebase already does. A price is frozen
 * onto the version as `priceSnapshotId`; a financing payment as `financeRateCardId`,
 * whose schema comment reads "loading next year's rates therefore cannot restate a
 * payment a customer has already been given in writing". This is that pattern applied to
 * the legal text: `ProposalVersion.legalSnapshotId`.
 *
 * Snapshots are content-addressed by SHA-256, so releasing fifty proposals under one
 * wording writes one row and fifty references. That also makes the reverse question
 * answerable — every proposal released under a given wording shares a snapshot id.
 */

export interface ResolvedLegalDocument {
  key: LegalKey;
  title: string;
  content: LegalDocumentContent;
  /** Which published revision this is. 0 means the shipped default, never edited. */
  version: number;
}

/** The two documents as they would print right now. */
export async function currentLegalDocuments(
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ResolvedLegalDocument[]> {
  const rows = await client.legalDocument.findMany({
    where: { key: { in: [...LEGAL_KEYS] } },
    select: { key: true, content: true, version: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return LEGAL_KEYS.map((key) => {
    const row = byKey.get(key);
    if (!row) {
      // No row: a fresh environment, or a seed that never ran. The shipped text prints
      // rather than nothing at all — a proposal that goes out with no terms attached is
      // worse than one that goes out with the wording this release was built with.
      return { key, title: defaultContent(key).title, content: defaultContent(key), version: 0 };
    }
    const content = row.content as unknown as LegalDocumentContent;
    return { key, title: content.title, content, version: row.version };
  });
}

/**
 * Freeze the current legal text and return the snapshot id.
 *
 * Called inside the release transaction, so a release that rolls back leaves no orphan
 * snapshot — and, more importantly, a proposal can never be frozen without one.
 */
export async function snapshotLegalDocuments(
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<string> {
  const docs = await currentLegalDocuments(client);
  const payload = docs.map((d) => ({
    key: d.key,
    title: d.title,
    version: d.version,
    content: d.content,
  }));

  // Stable stringify: the key order above is fixed by LEGAL_KEYS, and each content object
  // came from JSON, so property order is already deterministic. Hashing the same wording
  // twice must produce the same id or the dedupe silently stops working.
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json).digest('hex');

  const existing = await client.legalSnapshot.findUnique({ where: { hash }, select: { id: true } });
  if (existing) return existing.id;

  const created = await client.legalSnapshot.create({
    data: { hash, documents: payload as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  return created.id;
}

/**
 * What a given proposal version's documents say.
 *
 * The snapshot when there is one, the live documents when there is not. A version
 * released before this feature existed has no snapshot, and the honest answer for it is
 * the current text with `pinned: false` — not a fabricated history.
 */
export async function legalDocumentsForVersion(
  versionId: string,
): Promise<{ pinned: boolean; documents: ResolvedLegalDocument[] }> {
  const version = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: { legalSnapshotId: true },
  });
  if (version?.legalSnapshotId) {
    const snap = await prisma.legalSnapshot.findUnique({
      where: { id: version.legalSnapshotId },
      select: { documents: true },
    });
    if (snap) {
      return { pinned: true, documents: snap.documents as unknown as ResolvedLegalDocument[] };
    }
  }
  return { pinned: false, documents: await currentLegalDocuments() };
}

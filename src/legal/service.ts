import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  LEGAL_KEYS,
  SHIPPED_ORDER,
  defaultContent,
  type LegalDocumentContent,
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
  /**
   * Free text, not a union of two literals.
   *
   * Any number of documents can be added in Administration, so the key of one is whatever
   * it was created as. The two shipped keys are still special — they have fallback wording
   * in `defaults.ts` — but they are no longer the only ones that exist.
   */
  key: string;
  title: string;
  content: LegalDocumentContent;
  /** Which published revision this is. 0 means the shipped default, never edited. */
  version: number;
}

/**
 * Every enabled document, in the order it prints.
 *
 * Three rules, and each one is load-bearing:
 *
 * ORDER comes from `sortOrder`, ties broken on key. Never from whatever the database
 * happens to return: the sequence of documents in a signed instrument is part of the
 * instrument, and "usually right" is not a property a contract can have.
 *
 * DISABLED documents are absent. That is how a document is retired — the wording and its
 * revision history stay, so a proposal released under it can still be explained years
 * later, but it stops printing on new ones.
 *
 * A MISSING shipped document falls back to the wording in `defaults.ts`, at its
 * conventional position. A fresh environment, or a seed that never ran, prints the text
 * this release was built with rather than nothing — a proposal that goes out with no terms
 * attached is far worse than one that goes out with last month's.
 *
 * The fallback is keyed on the row being ABSENT, not on it being disabled. A document
 * someone deliberately switched off must stay off; resurrecting it from the defaults
 * because the row said `enabled: false` would be the opposite of what they asked for.
 */
export async function currentLegalDocuments(
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ResolvedLegalDocument[]> {
  const rows = await client.legalDocument.findMany({
    select: { key: true, content: true, version: true, sortOrder: true, enabled: true },
  });
  const present = new Set(rows.map((r) => r.key));

  const items: (ResolvedLegalDocument & { sortOrder: number })[] = rows
    .filter((r) => r.enabled)
    .map((r) => {
      const content = r.content as unknown as LegalDocumentContent;
      return {
        key: r.key,
        title: content.title,
        content,
        version: r.version,
        sortOrder: r.sortOrder,
      };
    });

  for (const key of LEGAL_KEYS) {
    if (present.has(key)) continue;
    const content = defaultContent(key);
    items.push({
      key,
      title: content.title,
      content,
      version: 0,
      sortOrder: SHIPPED_ORDER[key],
    });
  }

  items.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  return items.map(({ sortOrder: _sortOrder, ...doc }) => doc);
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

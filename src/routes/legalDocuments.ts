import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// A value import, not `import type`: Prisma.DbNull is a runtime sentinel, not a type.
// A nullable Json column cannot be cleared with plain `null` — that asks for the JSON
// value `null`, which is a different thing from an absent draft.
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import {
  LEGAL_KEYS,
  defaultContent,
  type LegalDocumentContent,
  type LegalKey,
} from '../legal/defaults.js';
import { currentLegalDocuments, legalDocumentsForVersion } from '../legal/service.js';

/**
 * The two legal documents that close a proposal, as editable records.
 *
 * Draft and published are separate columns, and only publishing changes what prints. A
 * legal document under revision is the one case where "save" must not mean "live": a
 * half-finished redline on tomorrow's proposal is worse than no edit at all.
 *
 * Editing is LEGAL_MANAGE, which only SYSTEM_ADMIN holds. Reading the effective text is
 * PROPOSAL_READ, because the proposal renderer needs it for anyone who can open a
 * proposal.
 */

const Sub = z.object({
  numeral: z.string().trim().max(8),
  text: z.string().trim().min(1).max(8000),
});

const Article = z.object({
  numeral: z.string().trim().max(8),
  title: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.string().trim().min(1).max(20000)).min(1),
  subs: z.array(Sub).max(12).default([]),
});

const Section = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
});

/**
 * A document's full content.
 *
 * `kind` is validated but not editable — a discriminator the renderer switches on. The
 * release is articles with a closing line above the signature blocks; the terms are
 * numbered clauses. Letting an editor change one into the other would produce a document
 * with signature blocks and no parties, or parties and nowhere to sign.
 */
const Content = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['ARTICLES', 'NUMBERED']),
    articles: z.array(Article).max(40).optional(),
    closing: z.string().trim().max(4000).optional(),
    sections: z.array(Section).max(60).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'ARTICLES' && !v.articles?.length) {
      ctx.addIssue({ code: 'custom', message: 'This document needs at least one article.' });
    }
    if (v.kind === 'NUMBERED' && !v.sections?.length) {
      ctx.addIssue({ code: 'custom', message: 'This document needs at least one clause.' });
    }
  });

/** Tokens the renderer knows how to fill. A typo here becomes a blank on a signed page. */
const KNOWN_TOKENS = ['customer', 'billingAddress', 'summitAddress', 'contactName'];

/**
 * Unrecognised merge tokens, reported rather than silently rendered.
 *
 * The release substitutes the customer and their address into its text. An edit that
 * writes `{{custmer}}` would print a gap on a legal instrument and nobody would know
 * which document caused it, so the save is refused and names the offender.
 */
function unknownTokens(content: LegalDocumentContent): string[] {
  const found = new Set<string>();
  const scan = (s: string): void => {
    for (const m of s.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (!KNOWN_TOKENS.includes(m[1]!)) found.add(m[1]!);
    }
  };
  scan(content.title);
  if (content.closing) scan(content.closing);
  for (const a of content.articles ?? []) {
    scan(a.title);
    a.paragraphs.forEach(scan);
    a.subs.forEach((s) => scan(s.text));
  }
  for (const s of content.sections ?? []) {
    scan(s.title);
    scan(s.body);
  }
  return [...found];
}

function assertKey(raw: string): LegalKey {
  const key = String(raw || '').toUpperCase() as LegalKey;
  if (!LEGAL_KEYS.includes(key)) throw new NotFoundError('Unknown legal document');
  return key;
}

/** The stored row plus the shipped default, which is what "reset" means. */
async function stateFor(key: LegalKey) {
  const row = await prisma.legalDocument.findUnique({ where: { key } });
  const shipped = defaultContent(key);
  const published = (row?.content as unknown as LegalDocumentContent) ?? shipped;
  return {
    key,
    kind: shipped.kind,
    published,
    publishedVersion: row?.version ?? 0,
    publishedAt: row?.publishedAt ?? null,
    publishedById: row?.publishedById ?? null,
    draft: (row?.draft as unknown as LegalDocumentContent | null) ?? null,
    draftSavedAt: row?.draftSavedAt ?? null,
    draftSavedById: row?.draftSavedById ?? null,
    /** True while this document has never been edited, so "reset" is a no-op. */
    isShipped: !row,
    shipped,
  };
}

export function registerLegalDocumentRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.LEGAL_MANAGE) };
  const read = { preHandler: requirePermission(Permission.PROPOSAL_READ) };

  /** Both documents, with draft state. The editor's only load. */
  app.get('/legal-documents', manage, async () => {
    const out = [];
    for (const key of LEGAL_KEYS) out.push(await stateFor(key));
    return out;
  });

  /**
   * What prints right now.
   *
   * Read by `public/contract-pages.js` when it builds a proposal. PROPOSAL_READ rather
   * than LEGAL_MANAGE: every rep who can open a proposal renders these pages.
   */
  app.get('/legal-documents/effective', read, async () => ({
    documents: await currentLegalDocuments(),
  }));

  /**
   * What a released proposal's documents said.
   *
   * `pinned: false` means this version predates snapshotting, and the answer is the
   * current text — stated rather than disguised.
   */
  app.get<{ Params: { id: string } }>('/proposals/versions/:id/legal', read, async (req) =>
    legalDocumentsForVersion(req.params.id),
  );

  /** Save an edit without publishing it. */
  app.put<{ Params: { key: string } }>('/legal-documents/:key/draft', manage, async (req) => {
    const key = assertKey(req.params.key);
    const shipped = defaultContent(key);
    const parsed = Content.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'This document is not valid.');
    }
    if (parsed.data.kind !== shipped.kind) {
      throw new ValidationError('A document cannot change between articles and numbered clauses.');
    }
    const bad = unknownTokens(parsed.data as LegalDocumentContent);
    if (bad.length) {
      const named = bad.map((b) => `{{${b}}}`).join(', ');
      const available = KNOWN_TOKENS.map((tok) => `{{${tok}}}`).join(', ');
      throw new ValidationError(
        `Unknown merge field${bad.length > 1 ? 's' : ''}: ${named}. Available: ${available}.`,
      );
    }

    const draft = parsed.data as unknown as Prisma.InputJsonValue;
    await prisma.legalDocument.upsert({
      where: { key },
      // A first draft on a never-edited document still needs a published copy to fall
      // back to, so the row is created carrying the shipped text as published.
      create: {
        key,
        title: shipped.title,
        content: shipped as unknown as Prisma.InputJsonValue,
        version: 1,
        draft,
        draftSavedAt: new Date(),
        draftSavedById: req.user!.sub,
      },
      update: { draft, draftSavedAt: new Date(), draftSavedById: req.user!.sub },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'legalDocument.draft',
      entity: 'LegalDocument',
      entityId: key,
      details: { title: parsed.data.title },
    });
    return stateFor(key);
  });

  /** Discard the draft, leaving the published copy alone. */
  app.delete<{ Params: { key: string } }>('/legal-documents/:key/draft', manage, async (req) => {
    const key = assertKey(req.params.key);
    await prisma.legalDocument.updateMany({
      where: { key },
      data: { draft: Prisma.DbNull, draftSavedAt: null, draftSavedById: null },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'legalDocument.draft.discard',
      entity: 'LegalDocument',
      entityId: key,
    });
    return stateFor(key);
  });

  /**
   * Publish the draft.
   *
   * The version number increments and the wording is written to
   * `LegalDocumentRevision`, which is append-only. From this moment every proposal
   * released prints the new text and every proposal already released keeps the old,
   * because the old one is pinned by `ProposalVersion.legalSnapshotId`.
   */
  app.post<{ Params: { key: string } }>('/legal-documents/:key/publish', manage, async (req) => {
    const key = assertKey(req.params.key);
    const row = await prisma.legalDocument.findUnique({ where: { key } });
    if (!row?.draft) throw new ValidationError('There is no draft to publish.');

    const parsed = Content.safeParse(row.draft);
    if (!parsed.success) {
      throw new ValidationError('The saved draft is no longer valid. Re-open and correct it.');
    }
    const content = parsed.data as unknown as Prisma.InputJsonValue;
    const nextVersion = row.version + 1;

    await prisma.$transaction(async (tx) => {
      await tx.legalDocumentRevision.create({
        data: {
          key,
          version: nextVersion,
          title: parsed.data.title,
          content,
          publishedById: req.user!.sub,
        },
      });
      await tx.legalDocument.update({
        where: { key },
        data: {
          title: parsed.data.title,
          content,
          version: nextVersion,
          publishedAt: new Date(),
          publishedById: req.user!.sub,
          draft: Prisma.DbNull,
          draftSavedAt: null,
          draftSavedById: null,
        },
      });
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'legalDocument.publish',
      entity: 'LegalDocument',
      entityId: key,
      details: { version: nextVersion, title: parsed.data.title },
    });
    return stateFor(key);
  });

  /** Load the shipped wording into the draft, so a bad edit can be abandoned wholesale. */
  app.post<{ Params: { key: string } }>(
    '/legal-documents/:key/restore-shipped',
    manage,
    async (req) => {
      const key = assertKey(req.params.key);
      const shipped = defaultContent(key);
      await prisma.legalDocument.upsert({
        where: { key },
        create: {
          key,
          title: shipped.title,
          content: shipped as unknown as Prisma.InputJsonValue,
          version: 1,
          draft: shipped as unknown as Prisma.InputJsonValue,
          draftSavedAt: new Date(),
          draftSavedById: req.user!.sub,
        },
        update: {
          draft: shipped as unknown as Prisma.InputJsonValue,
          draftSavedAt: new Date(),
          draftSavedById: req.user!.sub,
        },
      });
      await recordAudit({
        actorId: req.user!.sub,
        action: 'legalDocument.draft.restoreShipped',
        entity: 'LegalDocument',
        entityId: key,
      });
      return stateFor(key);
    },
  );

  /** Published history, newest first, for provenance beside the editor. */
  app.get<{ Params: { key: string } }>('/legal-documents/:key/revisions', manage, async (req) => {
    const key = assertKey(req.params.key);
    return prisma.legalDocumentRevision.findMany({
      where: { key },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, title: true, publishedById: true, createdAt: true },
      take: 50,
    });
  });
}

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

const Subsection = z.object({
  letter: z.string().trim().max(8),
  title: z.string().trim().min(1).max(200),
  // `.default([])`, not `.min(1)`. A sub-section just added in the editor has no text yet,
  // and "Array must contain at least 1 element" tells the person nothing about which
  // block or what to do. The refinement below names it instead.
  paragraphs: z.array(z.string().trim().min(1).max(20000)).default([]),
});

/*
 * `paragraphs` is no longer `.min(1)`, and `subs` is no longer capped at 12.
 *
 * Both limits were wrong, and a real document showed why. An article made entirely of
 * lettered sub-sections has no prose of its own — its opening line IS sub-section A — so
 * requiring a paragraph would have forced an empty one to be invented. And an article
 * enumerating released claims ran to twelve items, sitting exactly on the old cap, so the
 * thirteenth would have been refused with a validation error rather than a reason.
 *
 * An article must still say SOMETHING, which the refinement below enforces across all
 * three containers rather than demanding it from one of them.
 */
const Article = z.object({
  numeral: z.string().trim().max(8),
  title: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.string().trim().min(1).max(20000)).default([]),
  subs: z.array(Sub).max(40).default([]),
  subsections: z.array(Subsection).max(26).default([]),
  trailing: z.array(z.string().trim().min(1).max(20000)).default([]),
});

/*
 * A numbered clause, which now takes the same parts an article does.
 *
 * `body` stays required and stays the prose. It was tempting to replace it with
 * `paragraphs` for symmetry, and wrong: every stored terms document has `body`, the
 * renderer produces identical output from either, and a migration of live legal wording
 * to gain nothing but tidiness is a bad trade on a signed instrument.
 */
const Section = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  subs: z.array(Sub).max(40).default([]),
  subsections: z.array(Subsection).max(26).default([]),
  trailing: z.array(z.string().trim().min(1).max(20000)).default([]),
});

/**
 * A document's full content.
 *
 * `kind` is validated but not editable — a discriminator the renderer switches on. The
 * release is articles with a closing line above the signature blocks; the terms are
 * numbered clauses. Letting an editor change one into the other would produce a document
 * with signature blocks and no parties, or parties and nowhere to sign.
 */
/*
 * Layout, validated as a closed set.
 *
 * Bounded rather than free: a 40pt body or a 4.0 line height would push a signature block
 * off the foot of a printed sheet, and the paginator would place it on a page of its own
 * with the article it belongs to two pages back. The renderer clamps as well, so stored
 * content from any source is safe, but refusing here means the person who typed it finds
 * out immediately instead of discovering it on a customer's copy.
 */
const Style = z.object({
  // 'plex' matches the rest of the application and is the only face guaranteed to be
  // present in the PDF render; see the note in public/contract-pages.js.
  font: z.enum(['aptos', 'plex', 'georgia']).default('plex'),
  sizePt: z.coerce.number().min(7).max(12).default(9),
  lineHeight: z.coerce.number().min(1.1).max(1.9).default(1.35),
  align: z.enum(['justify', 'left']).default('justify'),
  titlePt: z.coerce.number().min(11).max(22).default(15),
});

const Signature = z.object({
  leftRole: z.string().trim().min(1).max(60).default('Customer'),
  rightRole: z.string().trim().min(1).max(60).default('Summit Sensory Gym'),
  title: z.boolean().default(false),
});

const Content = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['ARTICLES', 'NUMBERED']),
    articles: z.array(Article).max(40).optional(),
    closing: z.string().trim().max(4000).optional(),
    sections: z.array(Section).max(60).optional(),
    // Unnumbered opening prose. Optional, and absent means absent — a document written
    // before this existed renders exactly as it did.
    preamble: z.array(z.string().trim().min(1).max(20000)).max(12).default([]),
    style: Style.optional(),
    signature: Signature.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'ARTICLES' && !v.articles?.length) {
      ctx.addIssue({ code: 'custom', message: 'This document needs at least one article.' });
    }
    // An article with a heading and nothing under it would print as a numeral, a title and
    // a gap. Satisfied by prose, a list or a sub-section — any of the three.
    (v.sections ?? []).forEach((s, i) => {
      s.subsections.forEach((ss, j) => {
        if (!ss.paragraphs.length) {
          const where = `${i + 1}${ss.letter || String.fromCharCode(65 + j)}`;
          ctx.addIssue({
            code: 'custom',
            message: `Sub-section ${where} (${ss.title}) has a heading but no text.`,
          });
        }
      });
    });
    (v.articles ?? []).forEach((a, i) => {
      if (!a.paragraphs.length && !a.subs.length && !a.subsections.length) {
        const which = a.numeral || String(i + 1);
        ctx.addIssue({
          code: 'custom',
          message:
            `Article ${which} (${a.title}) has no text. ` +
            `Add a paragraph, a list item or a sub-section.`,
        });
      }
      a.subsections.forEach((ss, j) => {
        if (!ss.paragraphs.length) {
          const where = `${a.numeral || i + 1}${ss.letter || String.fromCharCode(65 + j)}`;
          ctx.addIssue({
            code: 'custom',
            message: `Sub-section ${where} (${ss.title}) has a heading but no text.`,
          });
        }
      });
    });
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
  // Scanned like everything else: a merge-field typo here prints a visible gap at the top
  // of a signed instrument, which is the worst place to discover one.
  (content.preamble ?? []).forEach(scan);
  for (const a of content.articles ?? []) {
    scan(a.title);
    a.paragraphs.forEach(scan);
    a.subs.forEach((s) => scan(s.text));
    // Scanned too, or a typo in a sub-section would print a gap on a signed instrument
    // while the save reported success.
    for (const ss of a.subsections ?? []) {
      scan(ss.title);
      ss.paragraphs.forEach(scan);
    }
    (a.trailing ?? []).forEach(scan);
  }
  for (const s of content.sections ?? []) {
    scan(s.title);
    scan(s.body);
    // The same scan the articles get. A typo in a merge field prints a visible gap on a
    // signed document, and it must not be the customer who finds it.
    (s.subs ?? []).forEach((x) => scan(x.text));
    for (const ss of s.subsections ?? []) {
      scan(ss.title);
      ss.paragraphs.forEach(scan);
    }
    (s.trailing ?? []).forEach(scan);
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

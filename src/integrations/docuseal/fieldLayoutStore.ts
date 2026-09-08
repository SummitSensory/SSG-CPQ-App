import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * A rep's saved manual placement/size for one signature/date box — raw, unmerged with
 * that slot's shipped default. Every property is independently optional: a rep who only
 * ever dragged a box (never resized it) has `top`/`left` saved and nothing else, and a
 * property that was never saved falls back to SIGNATURE_FIELD_DEFAULTS (assembly.ts) —
 * that merge happens in each consumer, not here, because the two consumers merge onto
 * different things (proposal-document.js/contract-pages.js merge `top`/`left` onto "no
 * offset"; assembly.ts merges `width`/`height`/`fontSize` onto that slot's shipped
 * FieldSize) rather than one shared shape.
 */
export interface SavedFieldLayout {
  top?: number;
  left?: number;
  width?: number;
  height?: number;
  fontSize?: number;
}

const SINGLETON_KEY = 'default';

/** One row for the whole application — see the SignatureFieldLayout model comment. */
export async function getSavedFieldLayout(): Promise<Record<string, SavedFieldLayout>> {
  const row = await prisma.signatureFieldLayout.findUnique({ where: { key: SINGLETON_KEY } });
  return (row?.offsets as Record<string, SavedFieldLayout> | null) ?? {};
}

export async function saveFieldLayout(
  offsets: Record<string, SavedFieldLayout>,
  updatedById: string,
): Promise<void> {
  // A value cast, same as LegalDocument's own Json columns: an optional numeric
  // property serializes to valid JSON fine, but TypeScript's InputJsonValue has no
  // notion of "an object whose properties may be undefined."
  const json = offsets as unknown as Prisma.InputJsonValue;
  await prisma.signatureFieldLayout.upsert({
    where: { key: SINGLETON_KEY },
    create: { key: SINGLETON_KEY, offsets: json, updatedById },
    update: { offsets: json, updatedById },
  });
}

import { prisma } from '../lib/prisma.js';

/** The normalization before "&"/"and" were folded together; rows saved with it keep it. */
function legacyNormalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|company|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize an org name for fuzzy dedupe: lowercase, strip punctuation, accents,
 * common suffixes and the connective "and" (so "Smith & Jones" and "Smith and Jones"
 * are one name), collapse spaces.
 */
export function normalizeOrgName(name: string): string {
  return legacyNormalize(name)
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every stored `normalizedName` this name could already be saved under: today's form
 * plus the pre-"and" forms of both spellings, so an organization saved before the
 * change is still found whichever way it is typed now.
 */
export function orgNameKeys(name: string): string[] {
  const keys = [
    normalizeOrgName(name),
    legacyNormalize(name),
    legacyNormalize(name.replace(/&/g, ' and ')),
  ].filter(Boolean);
  return [...new Set(keys)];
}

export interface DuplicateHit {
  id: string;
  name: string;
  reason: string;
}

/** Return likely-duplicate organizations by normalized name (optionally excluding an id). */
export async function findDuplicateOrganizations(
  name: string,
  excludeId?: string,
): Promise<DuplicateHit[]> {
  const keys = orgNameKeys(name);
  if (!keys.length) return [];
  const matches = await prisma.organization.findMany({
    where: { normalizedName: { in: keys }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true },
    take: 5,
  });
  return matches.map((m) => ({ id: m.id, name: m.name, reason: 'normalized name match' }));
}

/** Detect an existing contact with the same email inside the same organization. */
export async function findDuplicateContact(
  organizationId: string,
  email: string | undefined,
  excludeId?: string,
): Promise<DuplicateHit[]> {
  if (!email) return [];
  const matches = await prisma.contact.findMany({
    where: {
      organizationId,
      email: email.toLowerCase(),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, firstName: true, lastName: true },
    take: 5,
  });
  return matches.map((m) => ({
    id: m.id,
    name: m.firstName + ' ' + m.lastName,
    reason: 'email match',
  }));
}

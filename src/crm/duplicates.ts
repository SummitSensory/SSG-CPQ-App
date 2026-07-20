import { prisma } from '../lib/prisma.js';

/** Normalize an org name for fuzzy dedupe: lowercase, strip punctuation, common suffixes, collapse spaces. */
export function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|company|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const normalized = normalizeOrgName(name);
  if (!normalized) return [];
  const matches = await prisma.organization.findMany({
    where: { normalizedName: normalized, ...(excludeId ? { id: { not: excludeId } } : {}) },
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
  return matches.map((m) => ({ id: m.id, name: m.firstName + ' ' + m.lastName, reason: 'email match' }));
}

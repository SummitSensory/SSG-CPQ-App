import type { ProposalSection, ProposalItem } from './sections.js';

export interface VersionDiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface VersionComparison {
  sections: VersionDiffEntry[];
  items: VersionDiffEntry[];
  meta: VersionDiffEntry[];
}

function diffItems(a: ProposalItem[], b: ProposalItem[]): VersionDiffEntry[] {
  const out: VersionDiffEntry[] = [];
  const aMap = new Map(a.map((i) => [i.ref, i]));
  const bMap = new Map(b.map((i) => [i.ref, i]));
  for (const [ref, bi] of bMap) {
    const ai = aMap.get(ref);
    if (!ai) out.push({ path: `item:${ref}`, kind: 'added', after: bi });
    else if (JSON.stringify(ai) !== JSON.stringify(bi)) out.push({ path: `item:${ref}`, kind: 'changed', before: ai, after: bi });
  }
  for (const [ref, ai] of aMap) {
    if (!bMap.has(ref)) out.push({ path: `item:${ref}`, kind: 'removed', before: ai });
  }
  return out;
}

function diffSections(a: ProposalSection[], b: ProposalSection[]): VersionDiffEntry[] {
  const out: VersionDiffEntry[] = [];
  const aMap = new Map(a.map((s) => [s.id, s]));
  const bMap = new Map(b.map((s) => [s.id, s]));
  for (const [id, bs] of bMap) {
    const as = aMap.get(id);
    if (!as) out.push({ path: `section:${id}`, kind: 'added', after: bs });
    else if (JSON.stringify(as) !== JSON.stringify(bs)) out.push({ path: `section:${id}`, kind: 'changed', before: as, after: bs });
  }
  for (const [id, as] of aMap) {
    if (!bMap.has(id)) out.push({ path: `section:${id}`, kind: 'removed', before: as });
  }
  return out;
}

export interface VersionSnapshot {
  sections: ProposalSection[];
  items: ProposalItem[];
  priceSnapshotId?: string | null;
  expirationDate?: string | null;
}

/** Structured comparison between two proposal versions. */
export function compareVersions(a: VersionSnapshot, b: VersionSnapshot): VersionComparison {
  const meta: VersionDiffEntry[] = [];
  if ((a.priceSnapshotId ?? null) !== (b.priceSnapshotId ?? null)) {
    meta.push({ path: 'priceSnapshotId', kind: 'changed', before: a.priceSnapshotId ?? null, after: b.priceSnapshotId ?? null });
  }
  if ((a.expirationDate ?? null) !== (b.expirationDate ?? null)) {
    meta.push({ path: 'expirationDate', kind: 'changed', before: a.expirationDate ?? null, after: b.expirationDate ?? null });
  }
  return { sections: diffSections(a.sections, b.sections), items: diffItems(a.items, b.items), meta };
}

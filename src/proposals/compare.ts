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

/**
 * A unique key per line. Lines are matched across versions by `ref`, but a line
 * without one (an API-written or imported row) used to key as `undefined`, and two
 * lines sharing a ref collapsed into one map entry — the later overwrote the earlier,
 * so a change to it never showed. A ref-less line keys by position (`#3`); a repeated
 * ref keys by occurrence (`a`, `a~2`, …).
 */
function keyedItems(items: ProposalItem[]): Map<string, ProposalItem> {
  const out = new Map<string, ProposalItem>();
  const seen = new Map<string, number>();
  items.forEach((item, idx) => {
    const ref = typeof item?.ref === 'string' && item.ref !== '' ? item.ref : null;
    if (ref === null) {
      out.set(`#${idx}`, item);
      return;
    }
    const n = (seen.get(ref) ?? 0) + 1;
    seen.set(ref, n);
    out.set(n === 1 ? ref : `${ref}~${n}`, item);
  });
  return out;
}

function diffItems(a: ProposalItem[], b: ProposalItem[]): VersionDiffEntry[] {
  const out: VersionDiffEntry[] = [];
  const aMap = keyedItems(a);
  const bMap = keyedItems(b);
  for (const [ref, bi] of bMap) {
    const ai = aMap.get(ref);
    if (!ai) out.push({ path: `item:${ref}`, kind: 'added', after: bi });
    else if (JSON.stringify(ai) !== JSON.stringify(bi))
      out.push({ path: `item:${ref}`, kind: 'changed', before: ai, after: bi });
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
    else if (JSON.stringify(as) !== JSON.stringify(bs))
      out.push({ path: `section:${id}`, kind: 'changed', before: as, after: bs });
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
    meta.push({
      path: 'priceSnapshotId',
      kind: 'changed',
      before: a.priceSnapshotId ?? null,
      after: b.priceSnapshotId ?? null,
    });
  }
  if ((a.expirationDate ?? null) !== (b.expirationDate ?? null)) {
    meta.push({
      path: 'expirationDate',
      kind: 'changed',
      before: a.expirationDate ?? null,
      after: b.expirationDate ?? null,
    });
  }
  return {
    sections: diffSections(a.sections, b.sections),
    items: diffItems(a.items, b.items),
    meta,
  };
}

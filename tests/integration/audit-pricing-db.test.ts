import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * Audit: proposal numbering, version cloning and rule versioning against a REAL
 * database. Run with DATABASE_URL pointing at a disposable, migrated local database —
 * never production. Every row is created under a per-run actor id and removed in
 * afterAll.
 *
 * Proposal numbers are allocated per calendar year (P-YYYY-NNNNNN), so this file reads
 * the current high-water mark rather than assuming an empty table.
 */

const RUN = Date.now().toString(36);
const ACTOR = `audit-pricing-${RUN}`;
const ORG = `audit-org-${RUN}`;

let prisma: PrismaClient;
let svc: typeof import('../../src/proposals/service.js');
let rules: typeof import('../../src/rules/service.js');
const proposalIds: string[] = [];
const ruleIds: string[] = [];

/** sections that already carry a Project ID, so creation never consults monday. */
const SECTIONS = [{ id: 'meta', type: 'CUSTOMER_INFO', data: { projectId: `AUD-${RUN}` } }];

async function newProposal(title = 'audit'): Promise<{ id: string; number: string }> {
  const p = await svc.createProposal(
    {
      organizationId: ORG,
      title,
      sections: SECTIONS as never,
      items: [{ ref: 'a', lineType: 'PRODUCT', name: 'x', quantity: 1, rateMinor: 100 }] as never,
      expirationDate: new Date('2026-12-31T00:00:00Z'),
    },
    ACTOR,
  );
  proposalIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url))
    throw new Error('audit-pricing-db must run against a local database');
  ({ prisma } = await import('../../src/lib/prisma.js'));
  svc = await import('../../src/proposals/service.js');
  rules = await import('../../src/rules/service.js');
}, 60_000);

afterAll(async () => {
  if (!prisma) return;
  await prisma.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  await prisma.rule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.$disconnect();
});

describe('proposal numbering under concurrency (PASS)', () => {
  it('five simultaneous creates all succeed with five distinct, consecutive numbers', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => newProposal(`c${i}`)));
    const seqs = results.map((r) => Number(r.number.split('-')[2])).sort((a, b) => a - b);
    expect(new Set(results.map((r) => r.number)).size).toBe(5);
    expect(seqs[4]! - seqs[0]!).toBe(4);
    for (const r of results) expect(r.number).toMatch(/^P-\d{4}-\d{6}$/);
  }, 60_000);
});

describe('proposal versions (PASS)', () => {
  it('cloning creates v2 as a DRAFT without the price snapshot; discarding it lets the next clone reuse v2', async () => {
    const p = await newProposal('clone');
    const v1 = await prisma.proposalVersion.findFirstOrThrow({ where: { proposalId: p.id } });
    await prisma.proposalVersion.update({
      where: { id: v1.id },
      data: { priceSnapshotId: 'stale-snapshot' },
    });
    const v2 = await svc.createNewVersion(p.id, ACTOR);
    expect(v2.version).toBe(2);
    const row = await prisma.proposalVersion.findUniqueOrThrow({ where: { id: v2.versionId } });
    expect(row.status).toBe('DRAFT');
    expect(row.priceSnapshotId).toBeNull();
    expect(row.items).toEqual(v1.items);

    await svc.discardDraftVersion(v2.versionId, ACTOR);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } })).currentVersion).toBe(
      1,
    );
    const again = await svc.createNewVersion(p.id, ACTOR);
    expect(again.version).toBe(2);
  }, 60_000);

  it('the only version cannot be discarded', async () => {
    const p = await newProposal('only');
    const v1 = await prisma.proposalVersion.findFirstOrThrow({ where: { proposalId: p.id } });
    await expect(svc.discardDraftVersion(v1.id, ACTOR)).rejects.toThrow(/only version/);
  }, 60_000);

  it('release is refused while a line has no price; a frozen version refuses edits', async () => {
    const p = await newProposal('gate');
    const v1 = await prisma.proposalVersion.findFirstOrThrow({ where: { proposalId: p.id } });
    await svc.updateVersionContent(
      v1.id,
      { items: [{ ref: 'a', lineType: 'PRODUCT', name: 'Install', quantity: 1 }] as never },
      ACTOR,
    );
    await expect(svc.changeStatus(v1.id, 'RELEASED', ACTOR)).rejects.toThrow(/cannot be released/);
    await prisma.proposalVersion.update({
      where: { id: v1.id },
      data: { status: 'RELEASED', frozen: true },
    });
    await expect(svc.updateVersionContent(v1.id, { items: [] }, ACTOR)).rejects.toThrow(
      /immutable/,
    );
  }, 60_000);
});

describe('fixed defects (formerly it.fails)', () => {
  it('BUG: two simultaneous "new version" clicks surface a raw Prisma P2002 (500) instead of a clean result or 409', async () => {
    const p = await newProposal('race');
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => svc.createNewVersion(p.id, ACTOR)),
    );
    const { AppError } = await import('../../src/lib/errors.js');
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(AppError);
    }
  }, 60_000);

  it('BUG: adding a version to an ACTIVE rule puts the unapproved definition live immediately', async () => {
    const key = `audit-min-${RUN}`;
    const { id } = await rules.createRule(
      {
        key,
        type: 'MIN_QUANTITY',
        outcome: 'WARN',
        target: { productId: 'A' },
        params: { min: 2 },
      },
      ACTOR,
    );
    ruleIds.push(id);
    await rules.activateRule(id, ACTOR);
    await rules.addRuleVersion(
      id,
      {
        key,
        type: 'MIN_QUANTITY',
        outcome: 'BLOCK',
        target: { productId: 'A' },
        params: { min: 50 },
      },
      ACTOR,
      'draft change, not yet approved',
    );
    const live = (await rules.getActiveRuleDefs()).find((d) => d.id === id);
    // Expected: still v1 (min 2, WARN) until someone approves v2.
    expect(live?.params).toEqual({ min: 2 });
  }, 60_000);

  it('BUG: adding a version to an ACTIVE rule can introduce a dependency cycle (cycle check only runs on activate)', async () => {
    const a = `AUD${RUN}A`,
      b = `AUD${RUN}B`;
    const r1 = await rules.createRule(
      {
        key: `audit-req-ab-${RUN}`,
        type: 'REQUIRES',
        outcome: 'BLOCK',
        target: { productId: a },
        params: { productId: b },
      },
      ACTOR,
    );
    const r2 = await rules.createRule(
      {
        key: `audit-req-bx-${RUN}`,
        type: 'REQUIRES',
        outcome: 'BLOCK',
        target: { productId: b },
        params: { productId: `AUD${RUN}X` },
      },
      ACTOR,
    );
    ruleIds.push(r1.id, r2.id);
    await rules.activateRule(r1.id, ACTOR);
    await rules.activateRule(r2.id, ACTOR);
    let refused = false;
    try {
      await rules.addRuleVersion(
        r2.id,
        {
          key: `audit-req-bx-${RUN}`,
          type: 'REQUIRES',
          outcome: 'BLOCK',
          target: { productId: b },
          params: { productId: a },
        },
        ACTOR,
      );
    } catch {
      refused = true;
    }
    const { findCycle, buildDependencyEdges } = await import('../../src/rules/graph.js');
    const mine = (await rules.getActiveRuleDefs()).filter((d) => ruleIds.includes(d.id));
    expect(refused || findCycle(buildDependencyEdges(mine)) === null).toBe(true);
  }, 60_000);
});

describe('rule versions — the approved pointer (fix follow-up)', () => {
  it('activating the new version is what puts it live, and the pointer follows', async () => {
    const key = `audit-ptr-${RUN}`;
    const def = (min: number, outcome: 'WARN' | 'BLOCK') => ({
      key,
      type: 'MIN_QUANTITY' as const,
      outcome,
      target: { productId: 'A' },
      params: { min },
    });
    const { id } = await rules.createRule(def(2, 'WARN'), ACTOR);
    ruleIds.push(id);
    await rules.activateRule(id, ACTOR);
    await rules.addRuleVersion(id, def(50, 'BLOCK'), ACTOR);
    let live = (await rules.getActiveRuleDefs()).find((d) => d.id === id);
    expect(live).toMatchObject({ version: 1, outcome: 'WARN', params: { min: 2 } });

    await rules.activateRule(id, ACTOR);
    live = (await rules.getActiveRuleDefs()).find((d) => d.id === id);
    expect(live).toMatchObject({ version: 2, outcome: 'BLOCK', params: { min: 50 } });
    const row = await prisma.rule.findUniqueOrThrow({ where: { id } });
    expect(row.activeVersion).toBe(2);
  }, 60_000);
});

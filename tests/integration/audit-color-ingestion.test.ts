import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * AUDIT — colour INGESTION against a real database: monday Manufacturing Process row
 * → refreshPortal() → OrderPortalItem(kind COLOR).
 *
 * monday itself is replaced by a stub of mondayQuery that serves one Manufacturing row
 * carrying exactly what the Customer-Portal writes:
 *   - "Portal: Color Selections" (color_mm51hjph) — '✅' once the customer confirms
 *     (lib/monday.js PORTAL_DONE_LABEL via markSectionCompleteSafe)
 *   - "Portal: Color Selection Answers (JSON)" (long_text_mm6vj4d9) — the snapshot
 *     { selections, totalUpcharge, confirmedAt } (pages/api/portal/color-selection.js)
 * Nothing reaches the network. Every row is created under a per-run prefix and removed
 * in afterAll. The file refuses to run against anything but a localhost database.
 */

const board: {
  rows: Array<{ id: string; name: string; status: string; answers: string }>;
} = { rows: [] };

vi.mock('../../src/integrations/monday/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/monday/client.js')>();
  return {
    ...real,
    mondayQuery: vi.fn(async (query: string) => {
      // readManufacturingBoard asks for named column ids; fetchAllItems (the delivery
      // board walk) asks for every column. The delivery board is empty here.
      if (!query.includes('column_values (ids:')) {
        return { boards: [{ items_page: { cursor: null, items: [] } }] };
      }
      return {
        boards: [
          {
            items_page: {
              cursor: null,
              items: board.rows.map((r) => ({
                id: r.id,
                name: r.name,
                column_values: [
                  { id: 'link_to_deals__1', text: null, linked_item_ids: [] },
                  { id: 'color_mm51hjph', text: r.status },
                  { id: 'long_text_mm6vj4d9', text: r.answers },
                ],
              })),
            },
          },
        ],
      };
    }),
  };
});

const DB_URL = process.env.DATABASE_URL ?? '';
const LOCAL = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DB_URL);

const RUN = Date.now().toString(36).toUpperCase();
const P = `ZCI${RUN}`;
const ITEM_ID = `9${Date.now()}`; // the monday Manufacturing item id

const CONFIRMED = {
  selections: {
    structure_frame_paint: {
      legs: { brand: 'cardinal', code: 'T009-BG01' },
      horizontal_beams: { brand: 'prismatic', code: 'PRB-2826' },
      ladder_rungs_and_leg: { brand: 'cardinal', code: 'T009-BL05' },
    },
    climbing_wall_color: { climbing_wall: { brand: 'prismatic', code: 'PRB-4432' } },
    adventure_mat: { adventure_mat_system: { brand: 'vinyl', code: 'Kelly Green' } },
    palisades_mat: {
      palisades_mat_1: { brand: 'vinyl', code: 'Navy' },
      palisades_mat_2: { brand: 'vinyl', code: 'Orange' },
    },
    slide: { slide_color: { brand: 'plastic', code: 'Blue' } },
    slide_platform_paint: { slide_platform: { brand: 'cardinal', code: 'T009-BG01' } },
    climb_slide_mat: { climb_slide_piece_1: { brand: 'vinyl', code: 'Royal Blue' } },
    soft_steps_2_mat: {
      soft_steps_2: { brand: 'vinyl', code: 'Red' },
      soft_steps_2_piece_2: { brand: 'vinyl', code: 'White' },
    },
    foundation_mat: { foundation_mat: { brand: 'foundation', code: 'Green/Gray' } },
  },
  totalUpcharge: 300,
  confirmedAt: '2026-10-02T14:00:00.000Z',
};

let db: PrismaClient;
let portal: typeof import('../../src/portal/orderPortal.js');
let areas: typeof import('../../src/portal/colorAreas.js');
let userId = '';
let orgId = '';
let orderId = '';
const started = new Date();

async function refresh() {
  // A forced refresh claims a 10-second window; clear this run's claims so each step
  // really re-reads the board.
  await db.integrationSyncLog.deleteMany({
    where: { entity: 'portal-refresh', createdAt: { gte: started } },
  });
  const r = await portal.refreshPortal({ force: true, actorId: userId });
  expect(r.error).toBeNull();
  expect(r.refreshed).toBe(true);
  return db.orderPortalItem.findUniqueOrThrow({
    where: { orderId_kind: { orderId, kind: 'COLOR' } },
  });
}

describe.skipIf(!LOCAL)(
  'portal colour ingestion: monday row → OrderPortalItem (real database)',
  () => {
    beforeAll(async () => {
      process.env.MONDAY_API_TOKEN = 'audit-fake-token-never-sent';
      ({ prisma: db } = await import('../../src/lib/prisma.js'));
      portal = await import('../../src/portal/orderPortal.js');
      areas = await import('../../src/portal/colorAreas.js');

      userId = (
        await db.user.create({
          data: { email: `${P.toLowerCase()}@example.com`, passwordHash: 'x', name: 'Audit' },
        })
      ).id;
      orgId = (
        await db.organization.create({
          data: { name: `${P} Gym`, normalizedName: `${P.toLowerCase()} gym` },
        })
      ).id;
      const proposal = await db.proposal.create({
        data: { number: `${P}-P`, organizationId: orgId, title: 'Audit', createdById: userId },
      });
      const version = await db.proposalVersion.create({
        data: { proposalId: proposal.id, version: 1, sections: [], items: [], createdById: userId },
      });
      const snap = await db.priceSnapshot.create({
        data: {
          currency: 'USD',
          engineVersion: 'test',
          input: {},
          breakdown: {},
          grandTotal: 0n,
          createdById: userId,
        },
      });
      orderId = (
        await db.acceptedOrder.create({
          data: {
            number: `${P}-SO`,
            organizationId: orgId,
            proposalId: proposal.id,
            proposalVersionId: version.id,
            acceptedVersion: 1,
            priceSnapshotId: snap.id,
            currency: 'USD',
            grandTotalMinor: 0n,
            contentSnapshot: {},
            integrityHash: 'x',
            acceptedById: userId,
            portalOrderItemId: ITEM_ID,
          },
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (!db) return;
      if (orderId) {
        await db.orderEvent.deleteMany({ where: { orderId } });
        await db.acceptedOrder.deleteMany({ where: { id: orderId } });
      }
      await db.integrationSyncLog.deleteMany({
        where: { entity: 'portal-refresh', createdAt: { gte: started } },
      });
      await db.priceSnapshot.deleteMany({ where: { createdById: userId } });
      await db.proposalVersion.deleteMany({ where: { createdById: userId } });
      await db.proposal.deleteMany({ where: { createdById: userId } });
      await db.auditLog.deleteMany({ where: { actorId: userId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: userId } });
      await db.$disconnect();
    });

    it('an unconfirmed autosave (status not ✅) is not ingested', async () => {
      board.rows = [
        {
          id: ITEM_ID,
          name: `${P} job`,
          status: '',
          answers: JSON.stringify({ ...CONFIRMED, totalUpcharge: 0, confirmedAt: null }),
        },
      ];
      const item = await refresh();
      expect(item.state).toBe('NOT_PROVIDED');
      expect(item.answers).toBeNull();
      expect(item.sourceItemId).toBe(ITEM_ID);
    });

    it('a confirmed answer is stored verbatim and flattens to one pick per area', async () => {
      board.rows = [
        { id: ITEM_ID, name: `${P} job`, status: '✅', answers: JSON.stringify(CONFIRMED) },
      ];
      const item = await refresh();
      expect(item.state).toBe('PROVIDED');
      expect(item.mondayStatus).toBe('✅');
      expect(item.answers).toEqual(CONFIRMED);
      expect(portal.displayOf(item)).toBe('NEW');

      const picks = areas.colorAreasOf(item.answers);
      const expected = Object.entries(CONFIRMED.selections).flatMap(([g, parts]) =>
        Object.entries(parts).map(([a, v]) => ({ areaKey: `${g}.${a}`, group: g, area: a, ...v })),
      );
      expect(picks).toEqual(expected.sort((a, b) => a.areaKey.localeCompare(b.areaKey)));
      expect(picks).toHaveLength(13);
    });

    it('the same answers re-synced (keys reordered) do not un-review the item', async () => {
      const before = await db.orderPortalItem.findUniqueOrThrow({
        where: { orderId_kind: { orderId, kind: 'COLOR' } },
      });
      await db.orderPortalItem.update({
        where: { id: before.id },
        data: { reviewedHash: before.contentHash, reviewedAt: new Date(), reviewedById: userId },
      });
      board.rows[0]!.answers = JSON.stringify({
        confirmedAt: CONFIRMED.confirmedAt,
        selections: CONFIRMED.selections,
        totalUpcharge: CONFIRMED.totalUpcharge,
      });
      const item = await refresh();
      expect(item.contentHash).toBe(before.contentHash);
      expect(portal.displayOf(item)).toBe('REVIEWED');
    });

    it('a changed answer (staff-reset re-submission) replaces the old one and is NEW again', async () => {
      const before = await db.orderPortalItem.findUniqueOrThrow({
        where: { orderId_kind: { orderId, kind: 'COLOR' } },
      });
      const changed = structuredClone(CONFIRMED);
      changed.selections.structure_frame_paint.legs = { brand: 'prismatic', code: 'PRS-6118' };
      board.rows[0]!.answers = JSON.stringify(changed);
      const item = await refresh();
      expect(item.contentHash).not.toBe(before.contentHash);
      expect(portal.displayOf(item)).toBe('NEW');
      const legs = areas
        .colorAreasOf(item.answers)
        .find((p) => p.areaKey === 'structure_frame_paint.legs');
      expect(legs).toMatchObject({ brand: 'prismatic', code: 'PRS-6118' });
    });

    it('status back to 🚫 clears the stored answers', async () => {
      board.rows[0]!.status = '🚫';
      const item = await refresh();
      expect(item.state).toBe('NOT_PROVIDED');
      expect(item.answers).toBeNull();
    });

    it('FINDING (fixed): ✅ with no JSON (Jotform / "mark complete" path) is PROVIDED, and review says no colours arrived', async () => {
      board.rows[0] = { id: ITEM_ID, name: `${P} job`, status: '✅', answers: '' };
      const item = await refresh();
      expect(item.state).toBe('PROVIDED');
      expect(item.answers).toBeNull();
      expect(portal.displayOf(item)).toBe('NEW');

      const r = await portal.reviewPortalItem(orderId, 'COLOR', userId, item.contentHash!);
      // Review succeeds (never blocked), and the result now says why nothing applied.
      expect(r.colors).toEqual({
        linesUpdated: 0,
        unmappedAreas: [],
        noMatchingLines: [],
        skippedVendors: [],
        conflicts: [],
        linesAlreadyCurrent: 0,
        markedCompleteWithoutColors: true,
      });
    });

    it('✅ beside an unconfirmed draft (confirmedAt null) is treated as not provided — never reviewed onto the BOM', async () => {
      board.rows[0] = {
        id: ITEM_ID,
        name: `${P} job`,
        status: '✅',
        answers: JSON.stringify({ ...CONFIRMED, confirmedAt: null }),
      };
      const item = await refresh();
      expect(item.state).toBe('NOT_PROVIDED');
      expect(item.answers).toBeNull();
      expect(item.mondayStatus).toBe('✅');
      expect(portal.displayOf(item)).toBe('NONE');

      // Confirming it makes it a real answer.
      board.rows[0]!.answers = JSON.stringify(CONFIRMED);
      const confirmed = await refresh();
      expect(confirmed.state).toBe('PROVIDED');
      expect(portal.displayOf(confirmed)).toBe('NEW');
    });

    it('a draft stored and REVIEWED before the rule stays reviewed; an unreviewed stored draft cannot be reviewed', async () => {
      const draft = { ...CONFIRMED, confirmedAt: null };
      const hash = portal.contentHashOf('PROVIDED', draft);
      // As a sync before this rule would have stored it, and someone reviewed it.
      await db.orderPortalItem.update({
        where: { orderId_kind: { orderId, kind: 'COLOR' } },
        data: {
          state: 'PROVIDED',
          mondayStatus: '✅',
          answers: draft as object,
          contentHash: hash,
          reviewedHash: hash,
          reviewedAt: new Date(),
          reviewedById: userId,
        },
      });
      board.rows[0] = {
        id: ITEM_ID,
        name: `${P} job`,
        status: '✅',
        answers: JSON.stringify(draft),
      };
      const kept = await refresh();
      expect(kept.state).toBe('PROVIDED');
      expect(portal.displayOf(kept)).toBe('REVIEWED');

      // Unreviewed draft stored before the rule: reviewing it is refused, nothing applied.
      await db.orderPortalItem.update({
        where: { orderId_kind: { orderId, kind: 'COLOR' } },
        data: { reviewedHash: null, reviewedAt: null, reviewedById: null },
      });
      await expect(portal.reviewPortalItem(orderId, 'COLOR', userId, hash)).rejects.toThrow(
        /not confirmed/,
      );
      // …and the next sync sets it aside.
      const after = await refresh();
      expect(after.state).toBe('NOT_PROVIDED');
    });

    it('answers without a confirmedAt key (an older or foreign shape) are read as before', async () => {
      const { confirmedAt: _c, ...legacy } = CONFIRMED;
      expect(_c).toBeTruthy();
      board.rows[0] = {
        id: ITEM_ID,
        name: `${P} job`,
        status: '✅',
        answers: JSON.stringify(legacy),
      };
      const item = await refresh();
      expect(item.state).toBe('PROVIDED');
      expect(item.answers).toEqual(legacy);
    });
  },
);

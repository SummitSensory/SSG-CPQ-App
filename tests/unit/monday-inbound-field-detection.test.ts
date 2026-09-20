import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * applyInboundChange used to default `field` to 'opportunity.stage' whenever a
 * caller didn't pass it explicitly — and the only real caller (the webhook route)
 * never does. So ANY column change on a linked deal item (the amount, the owner, an
 * unrelated note) was evaluated as if it might be a stage change, and a status-type
 * column whose label happened to match one of the 7 STAGE_TO_STATUS values (e.g.
 * another status column also using "Won"/"Lost") would silently overwrite
 * Opportunity.stage. The fix: only treat an event as the stage field when its
 * columnId actually matches the verified stage column id.
 */

interface LinkRow {
  id: string;
  entity: string;
  entityId: string;
  externalId: string;
  state: string;
}

const links = new Map<string, LinkRow>();
links.set('item-1', {
  id: 'link1',
  entity: 'Opportunity',
  entityId: 'opp1',
  externalId: 'item-1',
  state: 'LINKED',
});

const seenEventIds = new Set<string>();
const opportunityUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    integrationSyncLog: {
      create: async ({ data }: { data: { eventId?: string } }) => {
        if (data.eventId) {
          if (seenEventIds.has(data.eventId)) {
            const err = new Error('duplicate') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          seenEventIds.add(data.eventId);
        }
        return {};
      },
    },
    externalLink: {
      findUnique: async ({
        where,
      }: {
        where: { provider_externalId?: { externalId: string } };
      }) => {
        const externalId = where.provider_externalId?.externalId;
        if (!externalId) return null;
        return links.get(externalId) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...links.values()].find((l) => l.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `link-${links.size + 1}`, ...data } as unknown as LinkRow;
        links.set(row.externalId, row);
        return row;
      },
    },
    opportunity: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        opportunityUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
  },
}));

const { applyInboundChange } = await import('../../src/integrations/monday/sync.js');
const { COLUMN } = await import('../../src/integrations/monday/mapping.js');

describe('applyInboundChange — field derived from columnId, not defaulted', () => {
  beforeEach(() => {
    opportunityUpdates.length = 0;
    seenEventIds.clear();
  });

  it('applies a stage change when columnId matches the real stage column', async () => {
    const result = await applyInboundChange({
      eventId: 'evt-stage-1',
      itemId: 'item-1',
      columnId: COLUMN.stage,
      newStatusLabel: 'Won',
    });
    expect(result).toBe('applied');
    expect(opportunityUpdates).toHaveLength(1);
    expect(opportunityUpdates[0]!.data).toEqual({ stage: 'CLOSED_WON' });
  });

  it('ignores a change on an unrelated column instead of treating it as a stage change', async () => {
    const result = await applyInboundChange({
      eventId: 'evt-other-1',
      itemId: 'item-1',
      columnId: 'some_unrelated_column',
      // A label that WOULD match STATUS_TO_STAGE if this were wrongly evaluated as
      // the stage field — proving the columnId check, not the label shape, is what
      // gates this.
      newStatusLabel: 'Won',
    });
    expect(result).toBe('ignored');
    expect(opportunityUpdates).toHaveLength(0);
  });

  it('ignores a numbers/amount-shaped column event with no label at all', async () => {
    const result = await applyInboundChange({
      eventId: 'evt-amount-1',
      itemId: 'item-1',
      columnId: 'deal_value',
      newStatusLabel: undefined,
    });
    expect(result).toBe('ignored');
    expect(opportunityUpdates).toHaveLength(0);
  });
});

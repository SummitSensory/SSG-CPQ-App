import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit: monday.com inbound deal-stage sync (src/integrations/monday/sync.ts).
 *
 * applyInboundChange claims the event id (unique IntegrationSyncLog.eventId)
 * BEFORE doing the work. monday retries a webhook that fails, so if the work
 * throws after the claim, the retry is answered "duplicate" and the change is
 * lost for good.
 *
 * Prisma is an in-memory stub with the real unique constraint on eventId.
 * No network: the monday client is never reached on the inbound path.
 */

const h = vi.hoisted(() => ({
  logs: [] as Array<Record<string, unknown>>,
  links: [] as Array<Record<string, unknown>>,
  opps: new Map<string, Record<string, unknown>>(),
  failNextOppUpdate: false,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/integrations/monday/client.js', () => ({
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    integrationSyncLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.eventId && h.logs.some((l) => l.eventId === data.eventId)) {
          throw Object.assign(new Error('Unique constraint failed on eventId'), { code: 'P2002' });
        }
        h.logs.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = h.logs.length;
        for (let i = h.logs.length - 1; i >= 0; i--) {
          const l = h.logs[i]!;
          if (Object.entries(where).every(([k, v]) => l[k] === v)) h.logs.splice(i, 1);
        }
        return { count: before - h.logs.length };
      },
    },
    externalLink: {
      findUnique: async ({ where }: { where: Record<string, Record<string, string>> }) => {
        if (where.provider_externalId) {
          return (
            h.links.find((l) => l.externalId === where.provider_externalId!.externalId) ?? null
          );
        }
        const k = where.provider_entity_entityId!;
        return h.links.find((l) => l.entity === k.entity && l.entityId === k.entityId) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = h.links.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.links.push({ id: `l${h.links.length + 1}`, ...data });
      },
    },
    opportunity: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (h.failNextOppUpdate) {
          h.failNextOppUpdate = false;
          throw new Error('connection reset');
        }
        const row = { ...h.opps.get(where.id)!, ...data };
        h.opps.set(where.id, row);
        return row;
      },
    },
  },
}));

import { applyInboundChange } from '../../src/integrations/monday/sync.js';
import { COLUMN } from '../../src/integrations/monday/mapping.js';
import { toStage } from '../../src/integrations/monday/crmMapping.js';

beforeEach(() => {
  h.logs.length = 0;
  h.links.length = 0;
  h.opps.clear();
  h.failNextOppUpdate = false;
  h.opps.set('opp-1', {
    id: 'opp-1',
    name: 'Gym',
    stage: 'PROPOSAL',
    fundingStatus: 'Unknown',
    budgetAmountMinor: null,
    budgetCurrency: 'USD',
  });
  h.links.push({
    id: 'l1',
    provider: 'monday',
    entity: 'Opportunity',
    entityId: 'opp-1',
    externalId: 'item-1',
    lastSyncedHash: null,
    state: 'LINKED',
  });
});

describe('applyInboundChange', () => {
  it('applies a stage change on the stage column', async () => {
    const r = await applyInboundChange({
      eventId: 'e1',
      itemId: 'item-1',
      columnId: COLUMN.stage,
      newStatusLabel: 'Won',
    });
    expect(r).toBe('applied');
    expect(h.opps.get('opp-1')!.stage).toBe('CLOSED_WON');
  });

  it('answers a redelivered event id as duplicate without re-applying', async () => {
    const change = {
      eventId: 'e2',
      itemId: 'item-1',
      columnId: COLUMN.stage,
      newStatusLabel: 'Lost',
    };
    expect(await applyInboundChange(change)).toBe('applied');
    expect(await applyInboundChange(change)).toBe('duplicate');
  });

  it('ignores a change on a column that is not synced', async () => {
    const r = await applyInboundChange({ eventId: 'e3', itemId: 'item-1', columnId: 'text_99' });
    expect(r).toBe('ignored');
    expect(h.opps.get('opp-1')!.stage).toBe('PROPOSAL');
  });

  it('ignores an item that is not linked to an opportunity', async () => {
    const r = await applyInboundChange({
      eventId: 'e4',
      itemId: 'unlinked',
      columnId: COLUMN.stage,
      newStatusLabel: 'Won',
    });
    expect(r).toBe('ignored');
  });

  it('refuses a change to a CPQ-authoritative field as a conflict', async () => {
    const r = await applyInboundChange({
      eventId: 'e5',
      itemId: 'item-1',
      field: 'opportunity.amount',
    });
    expect(r).toBe('conflict');
    expect(h.links[0]!.state).toBe('CONFLICT');
  });

  // BUG: the "received" row (unique eventId) is written before the work. If the
  // opportunity update throws, the webhook 500s, monday retries with the SAME
  // triggerUuid, and the retry returns 'duplicate' — the stage change is lost.
  it('BUG: a retry after a failed apply still applies the change', async () => {
    const change = {
      eventId: 'e6',
      itemId: 'item-1',
      columnId: COLUMN.stage,
      newStatusLabel: 'Won',
    };
    h.failNextOppUpdate = true;
    await applyInboundChange(change).catch(() => undefined);
    const retry = await applyInboundChange(change);
    expect(retry).toBe('applied');
    expect(h.opps.get('opp-1')!.stage).toBe('CLOSED_WON');
  });

  // Mapping drift: the CRM importer buckets Deal Phase labels fuzzily (toStage),
  // the webhook path requires an exact label from STAGE_TO_STATUS. A deal moved to
  // "Closed Won" on the board imports as CLOSED_WON but the live webhook ignores it.
  it('DRIFT: a label the importer maps to CLOSED_WON is also applied by the webhook', async () => {
    expect(toStage('Closed Won')).toBe('CLOSED_WON');
    const r = await applyInboundChange({
      eventId: 'e7',
      itemId: 'item-1',
      columnId: COLUMN.stage,
      newStatusLabel: 'Closed Won',
    });
    expect(r).toBe('applied');
  });
});

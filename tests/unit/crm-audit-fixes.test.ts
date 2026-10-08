import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import {
  businessDay,
  startOfBusinessDay,
  daysBetween,
  BUSINESS_TIME_ZONE,
} from '../../src/lib/businessTime.js';
import { BOM_TIME_ZONE } from '../../src/handoff/bomDelivery.js';
import { decisionDate } from '../../src/reporting/decision.js';
import { normalizeOrgName, orgNameKeys } from '../../src/crm/duplicates.js';
import { runReport } from '../../src/reporting/query.js';
import { inlineKnownAssets } from '../../src/render/pdf.js';
import { registerWebRoutes } from '../../src/routes/web.js';
import { buildReport } from '../../src/proposals/analytics.js';
import type { Dataset, Fact } from '../../src/reporting/dataset.js';

/** Follow-ups to the 2026-10-08 audit fixes that no pinned test covered directly. */

describe('business time (America/Denver)', () => {
  it('reuses the BOM time zone', () => {
    expect(BUSINESS_TIME_ZONE).toBe(BOM_TIME_ZONE);
  });

  it('dates an evening instant by the Mountain calendar', () => {
    expect(businessDay('2026-11-01T03:00:00.000Z')).toBe('2026-10-31'); // 21:00 MDT
    expect(businessDay('2026-01-01T06:59:59.000Z')).toBe('2025-12-31'); // 23:59 MST
    expect(businessDay('2026-01-01T07:00:00.000Z')).toBe('2026-01-01');
  });

  it('finds local midnight across both offsets', () => {
    expect(startOfBusinessDay('2026-07-01').toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(startOfBusinessDay('2026-12-01').toISOString()).toBe('2026-12-01T07:00:00.000Z');
    // DST starts 2026-03-08 at 02:00 local; midnight that day is still MST.
    expect(startOfBusinessDay('2026-03-08').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(startOfBusinessDay('2026-11-01').toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });

  it('counts calendar days', () => {
    expect(daysBetween('2026-10-08', '2026-10-10')).toBe(2);
    expect(daysBetween('2026-10-10', '2026-10-08')).toBe(-2);
  });
});

describe('one decision-date rule', () => {
  const at = (s: string) => new Date(s);
  it('is the latest decision on the current version', () => {
    expect(
      decisionDate([
        { toStatus: 'SENT', createdAt: at('2026-01-01T00:00:00Z') },
        { toStatus: 'REJECTED', createdAt: at('2026-01-05T00:00:00Z') },
        { toStatus: 'SENT', createdAt: at('2026-01-07T00:00:00Z') },
        { toStatus: 'ACCEPTED', createdAt: at('2026-01-09T00:00:00Z') },
      ])?.toISOString(),
    ).toBe('2026-01-09T00:00:00.000Z');
  });

  it('is null when the current version has not been decided', () => {
    expect(decisionDate([{ toStatus: 'SENT', createdAt: at('2026-01-01T00:00:00Z') }])).toBe(null);
  });
});

describe('Reports screen months are Mountain months', () => {
  it('a proposal decided at 9 pm Mountain on Oct 31 is an October decision', () => {
    const report = buildReport(
      [
        {
          id: 'p',
          number: 'P-1',
          title: 't',
          organizationId: 'o',
          organizationName: 'O',
          customerType: null,
          createdAt: new Date('2026-10-01T15:00:00Z'),
          updatedAt: new Date('2026-11-01T03:00:00Z'),
          createdById: 'u',
          preparedBy: null,
          versionCount: 1,
          latest: {
            id: 'v',
            version: 1,
            status: 'ACCEPTED',
            sections: [],
            items: [],
            expirationDate: null,
            releasedAt: null,
            createdAt: new Date('2026-10-01T15:00:00Z'),
            updatedAt: new Date('2026-11-01T03:00:00Z'),
            createdById: 'u',
            decidedAt: new Date('2026-11-01T03:00:00Z'),
          },
        },
      ] as never,
      {},
    );
    const months = report.winLossByMonth;
    const oct = months.find((m) => m.month === '2026-10');
    expect(oct?.won).toBe(1);
    expect(months.find((m) => m.month === '2026-11')?.won ?? 0).toBe(0);
  });
});

describe('CRM duplicate keys', () => {
  it('finds rows saved under the old normalization, whichever spelling is typed', () => {
    // Saved before the change: "&" was stripped, "and" was kept.
    const legacyAmp = 'smith jones therapy';
    const legacyAnd = 'smith and jones therapy';
    expect(orgNameKeys('Smith and Jones Therapy')).toEqual(
      expect.arrayContaining([legacyAmp, legacyAnd]),
    );
    expect(orgNameKeys('Smith & Jones Therapy')).toEqual(
      expect.arrayContaining([legacyAmp, legacyAnd]),
    );
    expect(normalizeOrgName('Smith & Jones Therapy')).toBe(legacyAmp);
  });
});

describe('margin bands', () => {
  function fact(id: string, marginPct: number): Fact {
    return {
      proposalId: id,
      number: id,
      title: '',
      status: 'SENT',
      version: 1,
      customerId: 'c',
      customer: 'C',
      customerType: 'OTHER',
      region: 'CO',
      country: 'US',
      repId: 'r',
      rep: 'R',
      createdAt: '2026-03-10T15:00:00.000Z',
      releasedAt: null,
      decidedAt: null,
      acceptedAt: null,
      orderedAt: null,
      depositPaidAt: null,
      paidInFullAt: null,
      totalMinor: 100,
      revenueMinor: 100,
      cogsMinor: 0,
      marginMinor: 0,
      marginPct,
      discountPct: 0,
      financed: false,
      lines: [],
    };
  }
  it('sorts a loss below every positive band', () => {
    const data: Dataset = {
      facts: [fact('a', 35), fact('b', -15), fact('c', 5)],
      builtAt: '',
      reps: [],
      customers: [],
      categories: [],
      manufacturers: [],
      proposalGroups: [],
      regions: [],
    };
    const res = runReport(data, {
      dateBasis: 'CREATED',
      groupBy: ['MARGIN_BAND'],
      measures: ['PROPOSALS'],
      sort: { key: 'd0_sort', dir: 'asc' },
    });
    expect(res.rows.map((r) => r.d0)).toEqual(['Below 0%', '0–20%', '30–40%']);
  });
});

describe('PDF: a marked house photo that cannot be read is dropped, not printed broken', () => {
  it('drops the tag for a missing local file and keeps data: and remote images', async () => {
    const html =
      '<div><img src="/proposal/does-not-exist.jpg" alt="" data-hide-broken="1" style="x"></div>' +
      '<img src="data:image/png;base64,AAAA" data-hide-broken="1">' +
      '<img src="/proposal/also-missing.jpg">';
    const out = await inlineKnownAssets(html);
    expect(out).not.toContain('does-not-exist.jpg');
    expect(out).toContain('data:image/png;base64,AAAA');
    // An unmarked image is left exactly as it was.
    expect(out).toContain('also-missing.jpg');
  });
});

describe('web: /proposal/* house art is served locally', () => {
  it('serves a house photo and refuses anything else', async () => {
    const app = Fastify();
    registerWebRoutes(app);
    await app.ready();
    const ok = await app.inject({ method: 'GET', url: '/proposal/flex-p3-unit.jpg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.rawPayload.length).toBeGreaterThan(1000);
    for (const bad of [
      '/proposal/..%2F..%2Fpackage.json',
      '/proposal/index.html',
      '/proposal/nope.jpg',
      '/proposal/.hidden.png',
    ]) {
      const r = await app.inject({ method: 'GET', url: bad });
      expect(r.statusCode, bad).toBe(404);
    }
    await app.close();
  });
});

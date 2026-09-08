import { describe, it, expect, vi } from 'vitest';

/**
 * The two bugs a real, already-completed envelope's Certificate of Signature
 * exposed: every signer's IP/Location was blank, and Summit's row showed the
 * Customer's drawn signature. Both trace to enrichSignersForCertificate in
 * service.ts — see the fixed functions' own comments for the root cause.
 * Prisma is mocked; nothing here touches a database.
 */

const db = vi.hoisted(() => ({
  esignEvent: { findMany: vi.fn() },
}));
vi.mock('../../src/lib/prisma.js', () => ({ prisma: db }));

import { ipInfoFromEvents, signatureImageFor } from '../../src/integrations/docuseal/service.js';
import type { DocusealSubmitter } from '../../src/integrations/docuseal/client.js';

describe('ipInfoFromEvents', () => {
  it('recovers IP per submitter from stored webhook payloads — the only place DocuSeal ever sends it', async () => {
    db.esignEvent.findMany.mockResolvedValueOnce([
      { payload: { data: { id: 111, ip: '24.9.44.164' } } },
      { payload: { data: { id: 222, ip: '203.0.113.5' } } },
    ]);
    const result = await ipInfoFromEvents('env_123');
    expect(result.get('111')).toBe('24.9.44.164');
    expect(result.get('222')).toBe('203.0.113.5');
  });

  it('keeps the most recent ip per submitter without letting an older event overwrite it', async () => {
    // Ordered most-recent-first, as the real query does (orderBy createdAt desc).
    db.esignEvent.findMany.mockResolvedValueOnce([
      { payload: { data: { id: 111, ip: '24.9.44.164' } } }, // newest
      { payload: { data: { id: 111, ip: '10.0.0.1' } } }, // older — must not win
    ]);
    const result = await ipInfoFromEvents('env_123');
    expect(result.get('111')).toBe('24.9.44.164');
  });

  it('skips events with no ip or no submitter id instead of throwing', async () => {
    db.esignEvent.findMany.mockResolvedValueOnce([
      { payload: { data: { id: 111, ip: null } } },
      { payload: { data: {} } },
      { payload: null },
      { payload: { data: { id: 333, ip: '24.9.44.164' } } },
    ]);
    const result = await ipInfoFromEvents('env_123');
    expect(result.size).toBe(1);
    expect(result.get('333')).toBe('24.9.44.164');
  });
});

function submitterWithValues(values: Array<{ field: string; value: unknown }>): DocusealSubmitter {
  return { id: 1, email: 'x@example.com', values };
}

describe('signatureImageFor', () => {
  it("only matches this signer's own role-prefixed signature field, even when another signer's field is also visible", async () => {
    // The exact shape of the real bug: DocuSeal's `values` array on the Summit
    // submitter carried both roles' drawn signatures, and a bare /signature$/i
    // match picked up whichever came first — here, the Customer's.
    const sub = submitterWithValues([
      { field: 'Customer Signature', value: 'data:image/png;base64,Y3VzdG9tZXI=' },
      { field: 'Summit Signature', value: 'data:image/png;base64,c3VtbWl0' },
    ]);
    const summitImage = await signatureImageFor(sub, 'Summit');
    expect(summitImage).toBe('data:image/png;base64,c3VtbWl0');
    const customerImage = await signatureImageFor(sub, 'Customer');
    expect(customerImage).toBe('data:image/png;base64,Y3VzdG9tZXI=');
  });

  it('returns null when this role has no signature field, rather than falling back to a different role', async () => {
    const sub = submitterWithValues([
      { field: 'Customer Signature', value: 'data:image/png;base64,Y3VzdG9tZXI=' },
    ]);
    expect(await signatureImageFor(sub, 'Summit')).toBeNull();
  });

  it('returns null for an undefined submitter', async () => {
    expect(await signatureImageFor(undefined, 'Summit')).toBeNull();
  });

  it('matches the role case-insensitively, since DocuSeal field names are user-authored text tags', async () => {
    const sub = submitterWithValues([
      { field: 'summit signature', value: 'data:image/png;base64,c3VtbWl0' },
    ]);
    expect(await signatureImageFor(sub, 'Summit')).toBe('data:image/png;base64,c3VtbWl0');
  });
});

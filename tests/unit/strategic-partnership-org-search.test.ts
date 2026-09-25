import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Strategic Partnership customer picker searches the whole CRM — organization
 * name, contact name or email, deal name — and says why each organization matched.
 */

type Row = {
  id: string;
  name: string;
  customerType: string;
  contacts: Array<{ firstName: string; lastName: string; email: string | null }>;
  opportunities: Array<{ name: string }>;
};
let rows: Row[] = [];
const findMany = vi.fn(async (_args: unknown) => rows);
vi.mock('../../src/lib/prisma.js', () => ({ prisma: { organization: { findMany } } }));

const search = async (q: string) =>
  (await import('../../src/strategicPartnership/orgSearch.js')).searchPartnershipOrganizations(q);

beforeEach(() => {
  rows = [];
  findMany.mockClear();
});

describe('searchPartnershipOrganizations', () => {
  it('does not query for a blank search', async () => {
    expect(await search('   ')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('matches organization name, contact name or email, and deal name', async () => {
    await search('Jen Gordon');
    const args = findMany.mock.calls[0]![0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(args.where.OR).toEqual([
      { name: { contains: 'Jen Gordon', mode: 'insensitive' } },
      {
        contacts: {
          some: {
            OR: [
              { email: { contains: 'Jen Gordon', mode: 'insensitive' } },
              {
                AND: [
                  {
                    OR: [
                      { firstName: { contains: 'Jen', mode: 'insensitive' } },
                      { lastName: { contains: 'Jen', mode: 'insensitive' } },
                    ],
                  },
                  {
                    OR: [
                      { firstName: { contains: 'Gordon', mode: 'insensitive' } },
                      { lastName: { contains: 'Gordon', mode: 'insensitive' } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { opportunities: { some: { name: { contains: 'Jen Gordon', mode: 'insensitive' } } } },
    ]);
  });

  it('puts name matches first and says why the others matched', async () => {
    rows = [
      {
        id: 'o1',
        name: 'Firefly Autism',
        customerType: 'PRIVATE_PRACTICE',
        contacts: [{ firstName: 'Jen', lastName: 'Gordon', email: 'jen@firefly.org' }],
        opportunities: [],
      },
      {
        id: 'o2',
        name: 'Lakewood Therapy',
        customerType: 'OTHER',
        contacts: [],
        opportunities: [{ name: 'Firefly referral build' }],
      },
      {
        id: 'o3',
        name: 'The Firefly Center',
        customerType: 'NONPROFIT',
        contacts: [],
        opportunities: [],
      },
    ];
    const hits = await search('firefly');
    expect(hits.map((h) => h.id)).toEqual(['o1', 'o3', 'o2']);
    expect(hits[0]!.via).toBeNull();
    expect(hits[2]!.via).toEqual({ kind: 'opportunity', label: 'Firefly referral build' });
  });

  it('labels a contact match with the person and their email', async () => {
    rows = [
      {
        id: 'o1',
        name: 'Firefly Autism',
        customerType: 'PRIVATE_PRACTICE',
        contacts: [{ firstName: 'Jen', lastName: 'Gordon', email: 'jen@firefly.org' }],
        opportunities: [],
      },
    ];
    const [hit] = await search('gordon');
    expect(hit!.via).toEqual({ kind: 'contact', label: 'Jen Gordon · jen@firefly.org' });
  });

  it('returns at most ten', async () => {
    rows = Array.from({ length: 30 }, (_, i) => ({
      id: 'o' + i,
      name: 'Org ' + i,
      customerType: 'OTHER',
      contacts: [],
      opportunities: [],
    }));
    expect(await search('org')).toHaveLength(10);
  });
});

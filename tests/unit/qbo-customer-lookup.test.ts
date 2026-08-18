import { describe, it, expect, vi } from 'vitest';

/**
 * QuickBooks customer adoption — the one change in this audit whose failure mode is
 * unrecoverable. Adopting the WRONG customer writes CPQ's address, email and contact
 * over a real customer's record in the company's books, with no undo. These cases pin
 * the rule that prevents it: only an unambiguous equality match may adopt automatically.
 */
const queryMock = vi.fn();
vi.mock('../../src/integrations/quickbooks/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const { findQboCustomerByName, stripAccountCode } =
  await import('../../src/integrations/quickbooks/customerLookup.js');

type Row = {
  Id: string;
  SyncToken: string;
  DisplayName?: string;
  CompanyName?: string;
  Active?: boolean;
};

/** Answer each `select … where <clause>` from a table of clause fragment → rows. */
function respond(table: Array<[string, Row[]]>): void {
  queryMock.mockReset();
  queryMock.mockImplementation(async (_realm: string, sql: string) => {
    for (const [fragment, rows] of table) if (sql.includes(fragment)) return { Customer: rows };
    return { Customer: [] };
  });
}

const row = (id: string, DisplayName: string, extra: Partial<Row> = {}): Row => ({
  Id: id,
  SyncToken: '0',
  DisplayName,
  ...extra,
});

describe('stripAccountCode', () => {
  it('removes a trailing deal code', () => {
    expect(stripAccountCode('The Therapy Spot LLC (R-4MBL1Z)')).toBe('The Therapy Spot LLC');
    expect(stripAccountCode('Acme Gyms [PS-2291]')).toBe('Acme Gyms');
  });

  it('keeps a parenthetical LOCATION — it identifies a different customer', () => {
    expect(stripAccountCode('Soar Autism Center (Fort Collins)')).toBe(
      'Soar Autism Center (Fort Collins)',
    );
    expect(stripAccountCode('Summit Kids (West)')).toBe('Summit Kids (West)');
  });

  it('leaves an ordinary name alone', () => {
    expect(stripAccountCode('The Therapy Spot LLC')).toBe('The Therapy Spot LLC');
  });
});

describe('findQboCustomerByName — what may be adopted automatically', () => {
  it('adopts an exact name match', async () => {
    respond([["DisplayName = 'Acme Gyms'", [row('11', 'Acme Gyms')]]]);
    const m = await findQboCustomerByName('r1', 'Acme Gyms');
    expect(m?.matchedOn).toBe('exact');
    expect(m?.autoAdoptable).toBe(true);
    expect(m?.customer.Id).toBe('11');
  });

  it('adopts once the deal code is ignored — the duplicate-customer bug', async () => {
    respond([["DisplayName = 'The Therapy Spot LLC'", [row('22', 'The Therapy Spot LLC')]]]);
    const m = await findQboCustomerByName('r1', 'The Therapy Spot LLC (R-4MBL1Z)');
    expect(m?.matchedOn).toBe('code-stripped');
    expect(m?.autoAdoptable).toBe(true);
  });

  it('adopts on an identical CompanyName', async () => {
    respond([
      ["CompanyName = 'Acme Gyms'", [row('33', 'Acme Gyms Inc', { CompanyName: 'Acme Gyms' })]],
    ]);
    const m = await findQboCustomerByName('r1', 'Acme Gyms');
    expect(m?.matchedOn).toBe('company-name');
    expect(m?.autoAdoptable).toBe(true);
  });

  it('NEVER adopts a prefix match — a suffix can be a different site', async () => {
    respond([["like 'Soar Autism Center%'", [row('44', 'Soar Autism Center - Glendale')]]]);
    const m = await findQboCustomerByName('r1', 'Soar Autism Center');
    expect(m?.matchedOn).toBe('prefix');
    expect(m?.autoAdoptable).toBe(false);
    expect(m?.customer.Id).toBe('44');
  });

  it('refuses to adopt when several active customers share the name', async () => {
    respond([["DisplayName = 'Acme Gyms'", [row('55', 'Acme Gyms'), row('56', 'Acme Gyms')]]]);
    const m = await findQboCustomerByName('r1', 'Acme Gyms');
    expect(m?.matchedOn).toBe('exact');
    expect(m?.autoAdoptable).toBe(false);
    expect(m?.ambiguousCount).toBe(2);
  });

  it('refuses to adopt a deactivated customer automatically', async () => {
    respond([["DisplayName = 'Acme Gyms'", [row('66', 'Acme Gyms', { Active: false })]]]);
    const m = await findQboCustomerByName('r1', 'Acme Gyms');
    expect(m?.autoAdoptable).toBe(false);
  });

  it('returns null when nothing matches, so the caller creates', async () => {
    respond([]);
    expect(await findQboCustomerByName('r1', 'Brand New Customer')).toBeNull();
  });

  it('treats a failed query as no match rather than throwing', async () => {
    queryMock.mockReset();
    queryMock.mockRejectedValue(new Error('QuickBooks HTTP 503'));
    await expect(findQboCustomerByName('r1', 'Acme Gyms')).resolves.toBeNull();
  });

  it('ignores an empty name without querying', async () => {
    respond([]);
    expect(await findQboCustomerByName('r1', '   ')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A brand-new customs entry takes the tariff item 9979.00.00 answer and the tariff
 * classification code from the admin defaults, and "Claimed, subject to CBSA
 * eligibility" is a qualifier on a claim — it never outlives the claim itself.
 */

const settingsRow = vi.fn();
const entryRow = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    proposalCustomsEntry: {
      findUnique: () => entryRow(),
      create: (args: unknown) => create(args),
      update: (args: unknown) => update(args),
    },
    proposalVersion: { findUnique: async () => ({ proposalId: 'p1' }) },
    crossBorderSetting: { findUnique: () => settingsRow() },
    proposalCrossBorderSnapshot: { findFirst: async () => null },
  },
}));
vi.mock('../../src/lib/audit.js', () => ({ recordAudit: async () => undefined }));

const { customsEntryFor, saveCustomsEntry } = await import('../../src/crossborder/customsEntry.js');

beforeEach(() => {
  settingsRow.mockReset();
  entryRow.mockReset().mockResolvedValue(null);
  create.mockReset().mockImplementation(async ({ data }: { data: object }) => data);
  update.mockReset().mockImplementation(async ({ data }: { data: object }) => data);
});

describe('customsEntryFor — seeding a new entry', () => {
  it('seeds "Claimed, subject to CBSA eligibility" and the default classification code', async () => {
    settingsRow.mockResolvedValue({
      defaultTariff9979Claimed: true,
      defaultTariff9979SubjectToCbsa: true,
      defaultTariffClassificationCode: '9506.91.00.90',
    });
    await customsEntryFor('v1');
    expect(create.mock.calls[0]![0].data).toMatchObject({
      tariff9979Claimed: true,
      tariff9979SubjectToCbsa: true,
      tariffClassificationCode: '9506.91.00.90',
    });
  });

  it('never seeds the CBSA qualifier without a claim', async () => {
    settingsRow.mockResolvedValue({
      defaultTariff9979Claimed: false,
      defaultTariff9979SubjectToCbsa: true,
      defaultTariffClassificationCode: null,
    });
    await customsEntryFor('v1');
    expect(create.mock.calls[0]![0].data).toMatchObject({
      tariff9979Claimed: false,
      tariff9979SubjectToCbsa: false,
      tariffClassificationCode: null,
    });
  });

  it('leaves both unset when there are no settings', async () => {
    settingsRow.mockResolvedValue(null);
    await customsEntryFor('v1');
    expect(create.mock.calls[0]![0].data).toMatchObject({
      tariff9979Claimed: null,
      tariff9979SubjectToCbsa: false,
      tariffClassificationCode: null,
    });
  });
});

describe('saveCustomsEntry — the CBSA qualifier', () => {
  const existing = {
    id: 'e1',
    status: 'REQUIRES_CUSTOMS_REVIEW',
    tariff9979Claimed: true,
    tariff9979SubjectToCbsa: true,
  };

  it('is kept while the entry stays claimed', async () => {
    entryRow.mockResolvedValue(existing);
    await saveCustomsEntry('v1', { tariff9979Claimed: true, tariff9979SubjectToCbsa: true }, 'u1');
    expect(update.mock.calls[0]![0].data.tariff9979SubjectToCbsa).toBe(true);
  });

  it('is cleared when the claim is withdrawn or set back to undetermined', async () => {
    for (const claimed of [false, null]) {
      update.mockClear();
      entryRow.mockResolvedValue(existing);
      await saveCustomsEntry('v1', { tariff9979Claimed: claimed }, 'u1');
      expect(update.mock.calls[0]![0].data.tariff9979SubjectToCbsa).toBe(false);
    }
  });
});

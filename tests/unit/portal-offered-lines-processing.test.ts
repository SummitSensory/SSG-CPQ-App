import { describe, it, expect, vi } from 'vitest';

/**
 * The customer colour-selection portal offers each purchase line that takes a colour.
 * A processing-supplier line (secondaryOfSku) is the processing supplier's fee on a part
 * already offered through its purchase line, so it must not be offered a second time.
 */

type Row = Record<string, unknown>;
const LINES: Row[] = [
  {
    id: 'buy',
    orderId: 'o1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 4,
    vendor: 'Amazon',
    isHardwareComponent: false,
    secondaryOfSku: null,
    colorPicks: null,
  },
  {
    id: 'fee',
    orderId: 'o1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 4,
    vendor: 'Goldberg Brothers',
    isHardwareComponent: false,
    secondaryOfSku: 'ABC',
    colorPicks: null,
  },
  {
    id: 'hw',
    orderId: 'o1',
    sku: 'ABC',
    name: 'Product A',
    quantity: 1,
    vendor: 'Amazon',
    isHardwareComponent: true,
    secondaryOfSku: null,
    colorPicks: null,
  },
];

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    procurementLine: {
      findMany: async ({ where }: { where: Row }) =>
        LINES.filter((l) =>
          Object.entries(where).every(([k, v]) => (v === null ? l[k] == null : l[k] === v)),
        ),
    },
  },
}));

vi.mock('../../src/vendorColors/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/vendorColors/service.js')>();
  const spec = {
    specId: 'spec-1',
    slotCount: 1,
    palette: { name: 'Standard', manufacturerName: 'Cardinal', finishType: 'POWDER' },
    colors: [{ id: 'c1', name: 'Green', vendorCode: 'G1' }],
  };
  return {
    ...real,
    specsForLines: async () => new Map([['ABC', spec]]),
    slotLabel: () => 'Colour',
  };
});

const { offeredLines } = await import('../../src/portal/colorSelection.js');

describe('offeredLines — processing lines', () => {
  it('offers the purchase line only, never the processing supplier’s fee line', async () => {
    const out = await offeredLines('o1');
    expect(out.map((l) => l.lineId)).toEqual(['buy']);
    expect(out[0]).toMatchObject({ vendor: 'Amazon', specId: 'spec-1' });
  });
});

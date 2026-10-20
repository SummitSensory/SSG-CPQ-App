import { prisma } from '../lib/prisma.js';

/**
 * The column headings of a Bill of Materials, editable under Catalog → BOM setup.
 *
 * Code finds a column by its KEY, never by the words on it, so a heading can read
 * anything without breaking the colour check or the zero-quantity greying that look
 * columns up. The words live in one UiSetting row as a map of only the headings that
 * were changed; everything else reads its default here.
 */

export interface BomColumnDef {
  key: string;
  /** What the heading reads until someone changes it. */
  label: string;
  /** Where it appears, for the person editing it. */
  where: string;
}

export const BOM_COLUMNS: BomColumnDef[] = [
  { key: 'item', label: 'Item', where: 'Order screen' },
  { key: 'vendor', label: 'Vendor', where: 'All-vendors sheet' },
  { key: 'part', label: 'Part #', where: 'Order screen and sheets' },
  { key: 'vendorPart', label: 'Vendor part #', where: 'Order screen and sheets' },
  { key: 'description', label: 'Description', where: 'Sheets' },
  { key: 'qty', label: 'Qty', where: 'Order screen and sheets' },
  { key: 'bag', label: 'Bag #', where: 'Order screen and sheets' },
  {
    key: 'color',
    label: 'Powder color',
    where: 'Order screen and sheets — a vendor’s own colour heading (vendor profile) wins',
  },
  { key: 'weight', label: 'Weight (lb)', where: 'Order screen and sheets' },
  // Renamed from "Cost Each" at Bryan's request (2026-10-19).
  { key: 'costEach', label: 'Vendor Cost', where: 'Order screen and sheets' },
  { key: 'totalCost', label: 'Total Cost', where: 'Order screen and sheets' },
  { key: 'invoicedEach', label: 'Invoiced each', where: 'Order screen' },
  { key: 'deltaDollar', label: 'Δ $', where: 'Order screen' },
  { key: 'deltaPct', label: 'Δ %', where: 'Order screen' },
  { key: 'notes', label: 'Notes', where: 'Order screen' },
  { key: 'status', label: 'Status', where: 'Order screen' },
  {
    key: 'secondaryCharge',
    // Was "Their charge", then "Vendor Cost"; named by Bryan 2026-10-19.
    label: 'Repackaging Service Fee',
    where: 'Catalog → BOM setup: what the Processing Service Supplier charges',
  },
];

export type BomColumnLabels = Record<string, string>;

export const BOM_COLUMN_LABELS_KEY = 'bom.columnLabels';

const DEFAULTS: BomColumnLabels = Object.fromEntries(BOM_COLUMNS.map((c) => [c.key, c.label]));

/** A heading is a short line of text; anything longer is not a heading. */
export const BOM_LABEL_MAX = 40;

/** The defaults with any saved headings over the top. Never throws: a bad row reads as none. */
export async function loadBomColumnLabels(): Promise<BomColumnLabels> {
  const p = prisma as unknown as { uiSetting?: { findUnique?: unknown } };
  // A test that stubs prisma without this table reads the defaults.
  if (typeof p.uiSetting?.findUnique !== 'function') return { ...DEFAULTS };
  const row = await prisma.uiSetting.findUnique({ where: { key: BOM_COLUMN_LABELS_KEY } });
  return { ...DEFAULTS, ...parseSaved(row?.value) };
}

function parseSaved(value: string | null | undefined): BomColumnLabels {
  if (!value) return {};
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: BomColumnLabels = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (k in DEFAULTS && typeof v === 'string' && v.trim()) out[k] = v.trim();
    return out;
  } catch {
    return {};
  }
}

/**
 * Save the headings. Only the ones that differ from their default are stored, so a
 * heading set back to its default — or left blank — follows the default from then on.
 */
export async function saveBomColumnLabels(
  labels: Record<string, string | null | undefined>,
  actorId: string,
): Promise<BomColumnLabels> {
  const changed: BomColumnLabels = {};
  for (const c of BOM_COLUMNS) {
    const v = (labels[c.key] ?? '').trim().slice(0, BOM_LABEL_MAX);
    if (v && v !== c.label) changed[c.key] = v;
  }
  if (Object.keys(changed).length) {
    const value = JSON.stringify(changed);
    await prisma.uiSetting.upsert({
      where: { key: BOM_COLUMN_LABELS_KEY },
      create: { key: BOM_COLUMN_LABELS_KEY, value, updatedById: actorId },
      update: { value, updatedById: actorId },
    });
  } else {
    await prisma.uiSetting.deleteMany({ where: { key: BOM_COLUMN_LABELS_KEY } });
  }
  return { ...DEFAULTS, ...changed };
}

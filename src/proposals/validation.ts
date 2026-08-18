import { z } from 'zod';

/**
 * Server-side validation for the proposal builder's own save shape.
 *
 * `PATCH /proposals/versions/:versionId` is the write path the entire application
 * hangs off — every line, price, quantity, discount and freight figure on every
 * proposal arrives through it. It used to take `req.body as { items?: unknown[] }`
 * and hand the array straight to Prisma, so the ONLY validation on the numbers a
 * proposal is built from was the browser's. Anything a caller could put in a JSON
 * body became proposal content: a negative quantity, a fractional cent, a rate of
 * 1e309, a 50 MB description, a `costEach` that disagrees with the catalog, or an
 * extra key nothing reads but everything now stores.
 *
 * That is not a hypothetical. `versionTotals()` (analytics.ts) multiplies quantity
 * by rateMinor with no guard, PriceSnapshot freezes the result, the QuickBooks
 * estimate asserts against that snapshot, and the customer's PDF prints it. One
 * malformed save propagates to the invoice and the signed contract.
 *
 * The schemas below are deliberately permissive about SHAPE — the builder carries
 * fields this module has no opinion on, and rejecting an unknown key would break
 * every proposal saved by a newer client than the server. They are strict about the
 * things that must be true of a financial document:
 *
 *   - money is an integer number of minor units, within a sane bound;
 *   - quantity is a non-negative integer;
 *   - text has a length limit;
 *   - the document as a whole has a line limit.
 *
 * Money bound: ±1e12 minor units, i.e. ten billion dollars. Well past the largest
 * imaginable sensory gym and far below the point where JSON numbers lose integer
 * precision (2^53), which is what protects the totals from silent drift.
 */

const MAX_MINOR = 1_000_000_000_000;
const MAX_QTY = 100_000;
const MAX_LINES = 2_000;
const MAX_TEXT = 20_000;

/** Integer minor units, bounded. Absent and null both mean "not answered yet". */
const minor = z
  .number()
  .refine((v) => Number.isFinite(v), 'must be a finite number')
  .refine((v) => Number.isInteger(v), 'money must be whole minor units (cents)')
  .refine((v) => Math.abs(v) <= MAX_MINOR, 'money is out of range');

const minorNullish = minor.nullish();

/** A quantity. Zero is legal — a note line, or a line parked at nil. */
const quantity = z
  .number()
  .refine(Number.isInteger, 'quantity must be a whole number')
  .refine((v) => v >= 0, 'quantity cannot be negative')
  .refine((v) => v <= MAX_QTY, 'quantity is out of range');

const text = (max = MAX_TEXT) => z.string().max(max);

/**
 * One builder line. `passthrough` keeps fields this schema does not name (the
 * configurator's own bookkeeping, kit components, display flags) instead of
 * silently dropping a rep's work, while every field that reaches a total is typed.
 */
export const BuilderLineSchema = z
  .object({
    lineType: text(40).optional(),
    kind: text(40).optional(),
    productId: text(120).nullish(),
    sku: text(120).nullish(),
    name: text(600).optional(),
    description: text().optional(),
    quantity: quantity.optional(),
    rateMinor: minorNullish,
    costEach: minorNullish,
    weightEach: z
      .number()
      .refine(Number.isFinite, 'weight must be a finite number')
      .refine((v) => v >= 0, 'weight cannot be negative')
      .refine((v) => v <= 1_000_000, 'weight is out of range')
      .nullish(),
    tpFreightMinor: minorNullish,
    tpFreightLabel: text(200).nullish(),
    group: text(200).nullish(),
    optional: z.boolean().nullish(),
    priceNote: text(400).nullish(),
    delivery: text(200).nullish(),
    returnable: text(200).nullish(),
    addlFreight: text(200).nullish(),
    freightCalc: text(200).nullish(),
    source: text(40).nullish(),
  })
  .passthrough();

/**
 * The header/meta section's data. Same rule: named where it touches money, open
 * elsewhere. Discount percentage is bounded at 100 — a 250% discount would drive
 * the total negative, and `versionTotals` clamps it after the fact rather than
 * refusing it, so the clamp and this bound together mean a stored proposal and a
 * recomputed one cannot disagree.
 */
export const BuilderMetaSchema = z
  .object({
    projectId: text(120).nullish(),
    contactName: text(200).nullish(),
    shipTo: text(2_000).nullish(),
    billTo: text(2_000).nullish(),
    proposalDate: text(40).nullish(),
    expiration: text(40).nullish(),
    taxAmountMinor: minorNullish,
    discountPct: z
      .number()
      .refine(Number.isFinite, 'discount must be a finite number')
      .refine((v) => v >= 0 && v <= 100, 'discount percentage must be between 0 and 100')
      .nullish(),
    discountMode: z.enum(['PCT', 'AMT']).nullish(),
    discountAmountMinor: minorNullish,
    structureFreightMinor: minorNullish,
    freightMinor: minorNullish,
    matsFreightMinor: minorNullish,
    stdFreightMinor: minorNullish,
    stdFreightOn: z.boolean().nullish(),
  })
  .passthrough();

export const BuilderSectionSchema = z
  .object({
    id: text(80),
    type: text(60),
    title: text(300).optional(),
    order: z.number().int().min(0).max(999).optional(),
    enabled: z.boolean().optional(),
    body: text().optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const VersionContentPatchSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  sections: z.array(BuilderSectionSchema).max(100).optional(),
  items: z.array(BuilderLineSchema).max(MAX_LINES).optional(),
  orderedSectionIds: z.array(text(80)).max(100).optional(),
  expirationDate: z.string().trim().max(40).optional(),
  /**
   * Optimistic concurrency. The version's `updatedAt` as the client last read it;
   * a save whose precondition no longer holds is refused instead of overwriting
   * whatever the other person just did. Optional so an older client keeps working
   * exactly as before (last-write-wins), which is why the field is documented here
   * as the thing the browser still has to start sending.
   */
  expectedUpdatedAt: z.string().trim().max(40).optional(),
});

export type VersionContentPatch = z.infer<typeof VersionContentPatchSchema>;

/**
 * Validate a meta section's data specifically. The generic section schema accepts
 * any `data` record — the header is the one whose contents drive money, so it is
 * checked separately and only when present.
 */
export function assertMetaSectionsValid(sections: unknown): void {
  if (!Array.isArray(sections)) return;
  for (const sec of sections) {
    const s = sec as { id?: string; data?: unknown };
    if (s?.id !== 'meta' || !s.data) continue;
    const parsed = BuilderMetaSchema.safeParse(s.data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Proposal header is invalid: ${issue?.path.join('.') ?? 'field'} — ${issue?.message ?? 'invalid'}`,
      );
    }
  }
}

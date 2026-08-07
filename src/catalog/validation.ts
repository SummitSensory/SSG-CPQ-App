import { z } from 'zod';

const nonNegInt = z.number().int().nonnegative();
// Dimensions in inches: fractional (e.g. 4.875), never negative.
const nonNegDecimal = z.coerce.number().nonnegative();

export const KindEnum = z.enum([
  'PRODUCT',
  'VARIANT',
  'COMPONENT',
  'BUNDLE',
  'ACCESSORY',
  'SERVICE',
]);
export const StatusEnum = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']);

export const SKU = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'SKU: 3-40 chars, A-Z 0-9 and hyphen');
export const Slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug: lowercase alphanumeric + hyphen');

// tierLevel is intentionally optional, not defaulted: omitting it means "infer
// from the parent" (see resolveCategoryTier), which a hardcoded default of 1
// would make indistinguishable from "explicitly tier 1".
export const CategoryInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  parentId: z.string().optional(),
  productLineId: z.string().optional(),
  tierLevel: z.number().int().min(1).max(4).optional(),
  productId: z.string().optional(),
  sortOrder: nonNegInt.default(0),
  isActive: z.boolean().default(true),
});

export const ProductLineInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  description: z.string().max(2000).optional(),
  sortOrder: nonNegInt.default(0),
  isActive: z.boolean().default(true),
});

export const ProductLineUpdate = ProductLineInput.partial();

export const FamilyInput = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  description: z.string().max(2000).optional(),
});

const activeRangeOk = (v: {
  activeFrom?: Date | undefined;
  activeTo?: Date | undefined;
}): boolean => !v.activeFrom || !v.activeTo || v.activeTo >= v.activeFrom;
const activeRangeMsg = { message: 'activeTo must be on or after activeFrom', path: ['activeTo'] };

// Base object (a ZodObject) so .partial()/.omit() stay available for ProductUpdate.
export const ProductNoteInput = z.object({
  text: z.string().trim().min(1).max(500),
});

export const ProductShape = z.object({
  sku: SKU,
  name: z.string().trim().min(2).max(200),
  kind: KindEnum.default('PRODUCT'),
  categoryId: z.string().min(1, 'category is required'),
  familyId: z.string().optional(),
  productLineId: z.string().optional(),
  defaultQuantity: z.number().int().positive().default(1),
  /**
   * Position among the siblings in this product's category. Drives the proposal
   * builder's insertion point, so it is editable on the product itself as well as
   * through /catalog/products/reorder. Optional rather than defaulted: leaving it
   * out of a PATCH must not silently reset a part to the top of its tier.
   */
  sortOrder: z.number().int().min(0).max(999999).optional(),
  badge: z.string().max(120).optional(),
  proposalDescription: z.string().max(5000).optional(),
  internalDescription: z.string().max(5000).optional(),
  lengthIn: nonNegDecimal.optional(),
  widthIn: nonNegDecimal.optional(),
  heightIn: nonNegDecimal.optional(),
  thicknessIn: nonNegDecimal.optional(),
  dimensionsOverride: z.string().max(200).optional(),
  showDimensions: z.boolean().default(false),
  weightOz: nonNegInt.optional(),
  capacity: z.string().max(120).optional(),
  activeFrom: z.coerce.date().optional(),
  activeTo: z.coerce.date().optional(),
  adminNotes: z.string().max(5000).optional(),
  notes: z.array(ProductNoteInput).default([]),
});

export const ProductInput = ProductShape.refine(activeRangeOk, activeRangeMsg);

export const ProductUpdate = ProductShape.partial()
  .omit({ sku: true })
  .refine(activeRangeOk, activeRangeMsg);

// ---------------- Manufacturing & sourcing ----------------

export const ManufacturerInput = z.object({
  name: z.string().trim().min(2).max(160),
  slug: Slug,
  isThirdParty: z.boolean().default(true),
  defaultLeadTimeDays: nonNegInt.max(3650).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: z.string().email().max(200).optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().default(true),
});

export const ManufacturerUpdate = ManufacturerInput.partial();

export const ProductSourcingInput = z.object({
  productId: z.string().min(1),
  manufacturerId: z.string().min(1),
  vendorPartNo: z.string().trim().max(80).optional(),
  leadTimeDays: nonNegInt.max(3650).optional(),
  minOrderQty: z.number().int().positive().max(100000).optional(),
  isPrimary: z.boolean().default(true),
  notes: z.string().max(2000).optional(),
});

export const ProductSourcingUpdate = ProductSourcingInput.partial().omit({ productId: true });

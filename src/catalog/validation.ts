import { z } from 'zod';

const nonNegInt = z.number().int().nonnegative();

export const KindEnum = z.enum(['PRODUCT','VARIANT','COMPONENT','BUNDLE','ACCESSORY','SERVICE']);
export const StatusEnum = z.enum(['DRAFT','ACTIVE','INACTIVE','ARCHIVED']);

export const SKU = z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'SKU: 3-40 chars, A-Z 0-9 and hyphen');
export const Slug = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug: lowercase alphanumeric + hyphen');

export const CategoryInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  parentId: z.string().optional(),
  sortOrder: nonNegInt.default(0),
  isActive: z.boolean().default(true),
});

export const FamilyInput = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  description: z.string().max(2000).optional(),
});

const activeRangeOk = (v) => !v.activeFrom || !v.activeTo || v.activeTo >= v.activeFrom;
const activeRangeMsg = { message: 'activeTo must be on or after activeFrom', path: ['activeTo'] };

// Base object (a ZodObject) so .partial()/.omit() stay available for ProductUpdate.
export const ProductShape = z.object({
  sku: SKU,
  name: z.string().trim().min(2).max(200),
  kind: KindEnum.default('PRODUCT'),
  categoryId: z.string().min(1, 'category is required'),
  familyId: z.string().optional(),
  proposalDescription: z.string().max(5000).optional(),
  internalDescription: z.string().max(5000).optional(),
  defaultQuantity: z.number().int().min(1).max(9999).default(1),
  badge: z.string().trim().max(24).optional(),
  lengthIn: nonNegInt.optional(),
  widthIn: nonNegInt.optional(),
  heightIn: nonNegInt.optional(),
  thicknessIn: nonNegInt.optional(),
  weightOz: nonNegInt.optional(),
  capacity: z.string().max(120).optional(),
  dimensionsOverride: z.string().trim().max(200).optional(),
  showDimensions: z.boolean().default(true),
  activeFrom: z.coerce.date().optional(),
  activeTo: z.coerce.date().optional(),
  adminNotes: z.string().max(5000).optional(),
});

export const ProductInput = ProductShape.refine(activeRangeOk, activeRangeMsg);

export const ProductUpdate = ProductShape.partial().omit({ sku: true }).refine(activeRangeOk, activeRangeMsg);

export const ProductLineInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  description: z.string().max(2000).optional(),
  sortOrder: nonNegInt.default(0),
  isActive: z.boolean().default(true),
});

export const ProductLineUpdate = ProductLineInput.partial();

// A tier node: tier 1 is always a header, product placements need tier 2+.
export const TierNodeShape = z.object({
  name: z.string().trim().min(2).max(120),
  slug: Slug,
  productLineId: z.string().min(1, 'product line is required'),
  tierLevel: z.number().int().min(1).max(4),
  parentId: z.string().optional(),
  productId: z.string().optional(),
  sortOrder: nonNegInt.default(0),
  isActive: z.boolean().default(true),
});

const tierRulesOk = (v) => {
  if (v.tierLevel === 1 && v.productId) return false;
  if (v.tierLevel === 1 && v.parentId) return false;
  if (v.tierLevel !== undefined && v.tierLevel > 1 && !v.parentId) return false;
  return true;
};
const tierRulesMsg = {
  message: 'tier 1 is a top-level header with no product; tiers 2-4 require a parent',
  path: ['tierLevel'],
};

export const TierNodeInput = TierNodeShape.refine(tierRulesOk, tierRulesMsg);
export const TierNodeUpdate = TierNodeShape.partial().refine(tierRulesOk, tierRulesMsg);

export const ProductNoteInput = z.object({
  productId: z.string().min(1),
  body: z.string().trim().min(1).max(2000),
  sortOrder: nonNegInt.default(0),
  isPublic: z.boolean().default(true),
});

export const ManufacturerInput = z.object({
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().max(24).optional(),
  contact: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().default(true),
});

export const ManufacturerUpdate = ManufacturerInput.partial();

export const ProductSourcingInput = z.object({
  productId: z.string().min(1),
  manufacturerId: z.string().min(1),
  vendorPartNo: z.string().trim().max(80).optional(),
  leadTimeDays: nonNegInt.max(3650).optional(),
  minOrderQty: z.number().int().min(1).max(100000).optional(),
  isPrimary: z.boolean().default(true),
  notes: z.string().max(2000).optional(),
});

export const ProductSourcingUpdate = ProductSourcingInput.partial().omit({ productId: true });

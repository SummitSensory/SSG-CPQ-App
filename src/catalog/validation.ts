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
  lengthIn: nonNegInt.optional(),
  widthIn: nonNegInt.optional(),
  heightIn: nonNegInt.optional(),
  weightOz: nonNegInt.optional(),
  capacity: z.string().max(120).optional(),
  activeFrom: z.coerce.date().optional(),
  activeTo: z.coerce.date().optional(),
  adminNotes: z.string().max(5000).optional(),
});

export const ProductInput = ProductShape.refine(activeRangeOk, activeRangeMsg);

export const ProductUpdate = ProductShape.partial().omit({ sku: true }).refine(activeRangeOk, activeRangeMsg);

import { z } from 'zod';

const nonNegInt = z.number().int().nonnegative();

export const CustomerTypeEnum = z.enum([
  'HEALTHCARE_SYSTEM','HOSPITAL','PRIVATE_PRACTICE','SCHOOL','UNIVERSITY','GOVERNMENT','NONPROFIT','OTHER',
]);
export const StageEnum = z.enum([
  'PROSPECT','QUALIFICATION','NEEDS_ANALYSIS','PROPOSAL','NEGOTIATION','CLOSED_WON','CLOSED_LOST',
]);
export const FundingEnum = z.enum([
  'UNFUNDED','BUDGETED','GRANT_PENDING','GRANT_AWARDED','APPROVED','SELF_FUNDED',
]);
export const TherapyEnum = z.enum([
  'PHYSICAL','OCCUPATIONAL','SPEECH','ABA','SENSORY_INTEGRATION','RECREATIONAL','AQUATIC','PSYCHOLOGICAL',
]);
export const PopulationEnum = z.enum([
  'PEDIATRIC','ADOLESCENT','ADULT','GERIATRIC','SPECIAL_NEEDS','VETERANS',
]);
export const FloorTypeEnum = z.enum(['CARPET','VINYL','TILE','CONCRETE','HARDWOOD','RUBBER','OTHER']);
export const WallEnum = z.enum(['DRYWALL','CONCRETE_BLOCK','BRICK','PLASTER','GLASS','MODULAR','OTHER']);
export const AttachmentCategoryEnum = z.enum(['PHOTOGRAPH','FLOOR_PLAN','MEASUREMENT_DOC','OTHER']);

export const OrganizationInput = z.object({
  name: z.string().trim().min(2).max(200),
  customerType: CustomerTypeEnum.default('OTHER'),
  taxExempt: z.boolean().default(false),
  taxExemptId: z.string().trim().max(64).optional(),
  notes: z.string().max(5000).optional(),
});

export const ContactInput = z.object({
  organizationId: z.string().min(1),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(120).optional(),
  isDecisionMaker: z.boolean().default(false),
  notes: z.string().max(5000).optional(),
});

export const AddressInput = z.object({
  organizationId: z.string().min(1),
  type: z.enum(['BILLING', 'SHIPPING']),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().length(2).default('US'),
});

export const RoomInput = z.object({
  facilityId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  lengthIn: nonNegInt.optional(),
  widthIn: nonNegInt.optional(),
  ceilingHeightIn: nonNegInt.optional(),
  doorWidthIn: nonNegInt.optional(),
  doorHeightIn: nonNegInt.optional(),
  floorType: FloorTypeEnum.optional(),
  wallConstruction: WallEnum.optional(),
  hasLoadingDock: z.boolean().default(false),
  liftgateRequired: z.boolean().default(false),
  deliveryRestrictions: z.string().max(2000).optional(),
  installationRestrictions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
});

// Budget accepted as a decimal STRING and stored as integer minor units — never a float.
export const OpportunityInput = z.object({
  organizationId: z.string().min(1),
  name: z.string().trim().min(2).max(200),
  stage: StageEnum.default('PROSPECT'),
  fundingStatus: FundingEnum.default('UNFUNDED'),
  therapyDisciplines: z.array(TherapyEnum).default([]),
  patientPopulations: z.array(PopulationEnum).default([]),
  budgetAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'money must be a decimal string').optional(),
  budgetCurrency: z.string().length(3).optional(),
  desiredTimeline: z.string().max(120).optional(),
  notes: z.string().max(5000).optional(),
}).refine((v) => !v.budgetAmount || !!v.budgetCurrency, {
  message: 'budgetCurrency is required when budgetAmount is set',
  path: ['budgetCurrency'],
});

export const AttachmentInput = z.object({
  category: AttachmentCategoryEnum.default('OTHER'),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  organizationId: z.string().optional(),
  opportunityId: z.string().optional(),
});

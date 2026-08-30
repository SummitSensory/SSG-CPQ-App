import { z } from 'zod';

/**
 * Catalog workbook importer.
 *
 * Consumes the normalized JSON produced from "Summit Product Workbook v3"
 * (prisma/seed-catalog.json) and validates it as a whole before anything
 * touches the database. The workbook — not the app — is the authoring surface,
 * so the import is idempotent: re-running it upserts by natural key (product
 * line slug, manufacturer name, product SKU, category slug).
 *
 * Money is integer minor units. Dimensions are decimal inches, matching the
 * Decimal(8,3) columns. Weight is whole ounces.
 */

export interface ImportIssue {
  sheet: string;
  key: string;
  message: string;
  severity: 'error' | 'warning';
}

const money = z.number().int().nonnegative();
const optInt = z.number().int().nonnegative().nullable().optional();
const optDecimal = z.number().nonnegative().nullable().optional();

export const SeedProductLine = z.object({
  name: z.string().trim().min(2),
  slug: z.string().trim().min(2),
  description: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export const SeedManufacturer = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().nullable().optional(),
  isThirdParty: z.boolean().default(true),
  defaultLeadTimeDays: optInt,
  contact: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});

export const SeedProduct = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  productLine: z.string().trim().min(1),
  defaultQuantity: z.number().int().min(1).default(1),
  unitPriceMinor: money.nullable(),
  badge: z.string().trim().nullable().optional(),
  lengthIn: optDecimal,
  widthIn: optDecimal,
  heightIn: optDecimal,
  thicknessIn: optDecimal,
  showDimensions: z.boolean().default(false),
  dimensionsOverride: z.string().trim().nullable().optional(),
  weightOz: optInt,
});

export const SeedTier = z.object({
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
  productLine: z.string().trim().min(1),
  tierLevel: z.number().int().min(1).max(4),
  defaultQuantity: optInt,
  parentSlug: z.string().nullable(),
  sku: z.string().nullable(),
  sortOrder: z.number().int().default(0),
});

export const SeedNote = z.object({
  sku: z.string().trim().min(1),
  text: z.string().trim().min(1),
  sortOrder: z.number().int().default(0),
});

export const SeedCost = z.object({
  sku: z.string().trim().min(1),
  unitCostMinor: money,
  currency: z.string().length(3).default('USD'),
  uom: z.string().trim().default('EA'),
  effectiveDate: z.string().trim().min(4),
  defaultedDate: z.boolean().optional(),
  sourceRef: z.string().nullable().optional(),
});

export const SeedSourcing = z.object({
  sku: z.string().trim().min(1),
  manufacturer: z.string().trim().min(1),
  vendorPartNo: z.string().nullable().optional(),
  leadTimeDays: optInt,
  minOrderQty: z.number().int().min(1).nullable().optional(),
  isPrimary: z.boolean().default(true),
  notes: z.string().nullable().optional(),
});

export const CatalogSeed = z.object({
  generatedAt: z.string().optional(),
  source: z.string().optional(),
  defaultEffectiveDate: z.string().optional(),
  productLines: z.array(SeedProductLine),
  manufacturers: z.array(SeedManufacturer),
  products: z.array(SeedProduct),
  tiers: z.array(SeedTier),
  notes: z.array(SeedNote),
  costs: z.array(SeedCost),
  sourcing: z.array(SeedSourcing),
});

export type CatalogSeedData = z.infer<typeof CatalogSeed>;

export interface ValidationReport {
  ok: boolean;
  counts: Record<string, number>;
  issues: ImportIssue[];
}

/**
 * Cross-sheet referential integrity — the things zod can't see across arrays.
 */
export function validateCatalogSeed(data: CatalogSeedData): ValidationReport {
  const issues: ImportIssue[] = [];
  const err = (sheet: string, key: string, message: string): number =>
    issues.push({ sheet, key, message, severity: 'error' });
  const warn = (sheet: string, key: string, message: string): number =>
    issues.push({ sheet, key, message, severity: 'warning' });

  const lineNames = new Set(data.productLines.map((l) => l.name));
  const manNames = new Set(data.manufacturers.map((m) => m.name));
  const skus = new Set<string>();

  for (const p of data.products) {
    if (skus.has(p.sku)) err('Products', p.sku, 'duplicate SKU');
    skus.add(p.sku);
    if (!lineNames.has(p.productLine))
      err('Products', p.sku, `unknown product line "${p.productLine}"`);
    if (p.unitPriceMinor == null) warn('Products', p.sku, 'no unit price');
  }

  const tierSlugs = new Set(data.tiers.map((t) => t.slug));
  const placedSkus = new Set<string>();
  for (const t of data.tiers) {
    if (!lineNames.has(t.productLine))
      err('Tier Structure', t.slug, `unknown product line "${t.productLine}"`);
    if (t.tierLevel === 1 && t.parentSlug)
      err('Tier Structure', t.slug, 'tier 1 cannot have a parent');
    if (t.tierLevel > 1 && !t.parentSlug)
      err('Tier Structure', t.slug, `tier ${t.tierLevel} requires a parent`);
    if (t.parentSlug && !tierSlugs.has(t.parentSlug))
      err('Tier Structure', t.slug, `parent "${t.parentSlug}" not found`);
    if (t.tierLevel === 1 && t.sku)
      err('Tier Structure', t.slug, 'tier 1 must be a header, not a product');
    if (t.sku) {
      if (!skus.has(t.sku)) err('Tier Structure', t.slug, `SKU ${t.sku} not in Products`);
      placedSkus.add(t.sku);
    }
  }
  for (const sku of skus) {
    if (!placedSkus.has(sku)) warn('Products', sku, 'not placed anywhere in the tier structure');
  }

  for (const n of data.notes) {
    if (!skus.has(n.sku)) err('Product Notes', n.sku, 'SKU not in Products');
  }

  const costedSkus = new Set<string>();
  for (const c of data.costs) {
    if (!skus.has(c.sku)) err('Costs', c.sku, 'SKU not in Products');
    if (Number.isNaN(Date.parse(c.effectiveDate)))
      err('Costs', c.sku, `unparseable effective date "${c.effectiveDate}"`);
    if (c.defaultedDate) warn('Costs', c.sku, 'no effective date given — defaulted to import date');
    costedSkus.add(c.sku);
  }
  for (const sku of skus) {
    if (!costedSkus.has(sku)) warn('Costs', sku, 'no cost on record — margin cannot be computed');
  }

  const sourcedSkus = new Set<string>();
  const primaryBySku = new Map<string, number>();
  for (const s of data.sourcing) {
    if (!skus.has(s.sku)) err('Product Sourcing', s.sku, 'SKU not in Products');
    if (!manNames.has(s.manufacturer))
      err('Product Sourcing', s.sku, `unknown manufacturer "${s.manufacturer}"`);
    if (s.isPrimary) primaryBySku.set(s.sku, (primaryBySku.get(s.sku) ?? 0) + 1);
    sourcedSkus.add(s.sku);
  }
  for (const [sku, n] of primaryBySku) {
    if (n > 1) err('Product Sourcing', sku, `${n} primary manufacturers — only one allowed`);
  }
  for (const sku of skus) {
    if (!sourcedSkus.has(sku))
      warn('Product Sourcing', sku, 'no manufacturer — will not appear on the BOM');
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    counts: {
      productLines: data.productLines.length,
      manufacturers: data.manufacturers.length,
      products: data.products.length,
      tierHeaders: data.tiers.filter((t) => !t.sku).length,
      tierPlacements: data.tiers.filter((t) => t.sku).length,
      notes: data.notes.length,
      costs: data.costs.length,
      sourcing: data.sourcing.length,
    },
    issues,
  };
}

/** Parse + validate in one step. Throws on a malformed envelope. */
export function loadCatalogSeed(raw: unknown): { data: CatalogSeedData; report: ValidationReport } {
  const data = CatalogSeed.parse(raw);
  return { data, report: validateCatalogSeed(data) };
}

/** Tier nodes ordered parents-before-children so inserts never hit a missing FK. */
export function tiersInInsertOrder(tiers: CatalogSeedData['tiers']): CatalogSeedData['tiers'] {
  return [...tiers].sort((a, b) => a.tierLevel - b.tierLevel || a.sortOrder - b.sortOrder);
}

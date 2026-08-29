import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { reassignSkuVendor } from '../handoff/vendorReassign.js';
import { recordRevision, skuSnapshot } from '../lib/revisions.js';

/**
 * The single catalog list.
 *
 * Historically the catalog lived in two places: `Product` (the rich record —
 * name, 4-tier category, dimensions, notes, manufacturer sourcing) and `Sku`
 * (the flat priced record the proposal engine multiplies against — part number,
 * unit price, unit cost, weight). Both are keyed by part number, so this route
 * joins them into ONE row per part and writes each edited field back to
 * whichever table owns it.
 */

/*
 * `slugify` lived here to mint a slug for a Manufacturer row created from a typed name.
 * Nothing creates one from this route any more — an unrecognised vendor is refused — so
 * the helper went with it. Vendors are created on the Manufacturers screen, which builds
 * its own slug alongside the address and payment terms that make the record usable.
 */

/**
 * `overrideAllowed` arrived in migration 0024. Read it optionally so the catalog
 * still loads if the code is deployed before the migration — a missing column
 * degrades to "nothing is overridable" rather than a P2022 on the whole list.
 */
let skuHasOverrideFlag = true;
const SKU_COLS = {
  id: true,
  part: true,
  description: true,
  category: true,
  manufacturer: true,
  unitPriceMinor: true,
  unitCostMinor: true,
  weightLbs: true,
  proposalGroup: true,
  active: true,
} as const;
type SkuRow = {
  id: string;
  part: string;
  description: string;
  category: string | null;
  manufacturer: string | null;
  unitPriceMinor: number;
  unitCostMinor: number;
  weightLbs: number;
  proposalGroup: string | null;
  active: boolean;
  overrideAllowed?: boolean;
  defaultQty?: number | null;
  freightMinor?: number | null;
  freightLabel?: string | null;
  productUrl?: string | null;
  requiresPowderColor?: boolean;
  packagingBag?: string | null;
};
async function listSkus(): Promise<SkuRow[]> {
  if (skuHasOverrideFlag) {
    try {
      return (await prisma.sku.findMany({
        select: {
          ...SKU_COLS,
          overrideAllowed: true,
          defaultQty: true,
          freightMinor: true,
          freightLabel: true,
          productUrl: true,
          requiresPowderColor: true,
          packagingBag: true,
        },
        orderBy: { part: 'asc' },
      })) as SkuRow[];
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2022') throw e;
      skuHasOverrideFlag = false;
    }
  }
  return (await prisma.sku.findMany({ select: SKU_COLS, orderBy: { part: 'asc' } })) as SkuRow[];
}

const ItemPatch = z.object({
  name: z.string().trim().min(1).max(400).optional(),
  category: z.string().trim().max(120).nullish(),
  manufacturer: z.string().trim().max(160).nullish(),
  unitPriceMinor: z.number().int().nonnegative().optional(),
  unitCostMinor: z.number().int().nonnegative().optional(),
  weightLbs: z.number().nonnegative().optional(),
  proposalGroup: z.string().trim().max(120).nullish(),
  active: z.boolean().optional(),
  overrideAllowed: z.boolean().optional(),
  defaultQty: z.number().int().min(0).max(9999).nullable().optional(),
  freightMinor: z.number().int().nonnegative().nullable().optional(),
  freightLabel: z.string().trim().max(120).nullish(),
  /** Vendor order page — becomes a "Buy" link on the Bill of Materials. */
  productUrl: z.string().trim().max(600).nullish(),
  /** Block BOM submission until this part carries a powder colour. */
  requiresPowderColor: z.boolean().optional(),
  /** Packaging bag the part ships in, e.g. "Bag 7". Blank clears it. */
  packagingBag: z.string().trim().max(60).nullish(),
});

export interface CatalogItem {
  part: string;
  name: string;
  category: string;
  categoryOptions: boolean;
  manufacturer: string;
  unitPriceMinor: number;
  unitCostMinor: number;
  weightLbs: number;
  proposalGroup: string;
  active: boolean;
  /** Pre-approved for part-number substitution in the Adventure Series builder. */
  overrideAllowed: boolean;
  /** Builder default quantity; null = no default, so the field starts at 0. */
  defaultQty: number | null;
  /** Fixed freight applied to this part's proposal line; null = none. */
  freightMinor: number | null;
  freightLabel: string | null;
  productUrl: string | null;
  requiresPowderColor: boolean;
  /** Packaging bag this part ships in; null when it is not bagged. */
  packagingBag: string | null;
  skuId: string | null;
  productId: string | null;
  productStatus: string | null;
}

export function registerCatalogItemRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/catalog/manufacturers', read, async () =>
    prisma.manufacturer.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, isThirdParty: true, freightTbd: true },
    }),
  );

  /** One row per part number, merged across Product and Sku. */
  app.get('/catalog/items', read, async (req) => {
    const { q = '', page = '1', pageSize = '100' } = req.query as Record<string, string>;
    const term = q.trim();
    const [skus, products, sourcing, cats, costs] = await Promise.all([
      listSkus(),
      prisma.product.findMany({
        select: { id: true, sku: true, name: true, status: true, categoryId: true, weightOz: true },
        orderBy: { sku: 'asc' },
      }),
      prisma.productSourcing.findMany({
        select: { productId: true, manufacturer: { select: { name: true } } },
      }),
      prisma.productCategory.findMany({
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
      // Dated cost history from the product workbook import — the fallback when the
      // flat Sku row has no cost of its own.
      prisma.productCost.findMany({
        select: { productId: true, unitCost: true, effectiveDate: true },
        orderBy: { effectiveDate: 'desc' },
      }),
    ]);
    const latestCost: Record<string, number> = {};
    for (const c of costs)
      if (latestCost[c.productId] === undefined) latestCost[c.productId] = Number(c.unitCost);
    const catName: Record<string, string> = {};
    for (const c of cats) catName[c.id] = c.name;
    const mfrByProduct: Record<string, string> = {};
    for (const s of sourcing)
      if (s.manufacturer?.name && !mfrByProduct[s.productId])
        mfrByProduct[s.productId] = s.manufacturer.name;

    const byPart = new Map<string, CatalogItem>();
    for (const s of skus) {
      byPart.set(s.part, {
        part: s.part,
        name: s.description,
        category: s.category || '',
        categoryOptions: false,
        manufacturer: s.manufacturer || '',
        unitPriceMinor: s.unitPriceMinor,
        unitCostMinor: s.unitCostMinor,
        weightLbs: s.weightLbs,
        proposalGroup: s.proposalGroup || '',
        active: s.active,
        overrideAllowed: s.overrideAllowed === true,
        defaultQty: s.defaultQty ?? null,
        freightMinor: s.freightMinor ?? null,
        freightLabel: s.freightLabel ?? null,
        productUrl: s.productUrl ?? null,
        packagingBag: s.packagingBag ?? null,
        requiresPowderColor: s.requiresPowderColor === true,
        skuId: s.id,
        productId: null,
        productStatus: null,
      });
    }
    for (const p of products) {
      const existing = byPart.get(p.sku);
      const productCategory = catName[p.categoryId] || '';
      const mfr = mfrByProduct[p.id] || '';
      if (existing) {
        // The Product record wins on name/category; the Sku record owns money,
        // falling back to the workbook's cost history and ounce weight.
        existing.name = p.name || existing.name;
        existing.category = productCategory || existing.category;
        existing.categoryOptions = true;
        existing.manufacturer = mfr || existing.manufacturer;
        const cost = latestCost[p.id];
        if (!existing.unitCostMinor && cost) existing.unitCostMinor = cost;
        if (!existing.weightLbs && p.weightOz)
          existing.weightLbs = Math.round((p.weightOz / 16) * 1000) / 1000;
        existing.productId = p.id;
        existing.productStatus = p.status;
      } else {
        byPart.set(p.sku, {
          part: p.sku,
          name: p.name,
          category: productCategory,
          categoryOptions: true,
          manufacturer: mfr,
          unitPriceMinor: 0,
          unitCostMinor: latestCost[p.id] || 0,
          weightLbs: p.weightOz ? Math.round((p.weightOz / 16) * 1000) / 1000 : 0,
          proposalGroup: '',
          active: p.status === 'ACTIVE',
          overrideAllowed: false,
          defaultQty: null,
          freightMinor: null,
          freightLabel: null,
          productUrl: null,
          requiresPowderColor: false,
          packagingBag: null,
          skuId: null,
          productId: p.id,
          productStatus: p.status,
        });
      }
    }
    let items = [...byPart.values()];
    if (term) {
      const t = term.toLowerCase();
      items = items.filter(
        (i) =>
          i.part.toLowerCase().includes(t) ||
          i.name.toLowerCase().includes(t) ||
          i.category.toLowerCase().includes(t) ||
          i.manufacturer.toLowerCase().includes(t),
      );
    }
    items.sort((a, b) => a.part.localeCompare(b.part));
    const total = items.length;
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 100));
    return {
      items: items.slice((pg - 1) * size, pg * size),
      total,
      page: pg,
      pageSize: size,
      categories: cats,
    };
  });

  /**
   * Edit one merged row. Each field is written where it lives:
   *   name        -> Product.name when a Product exists, else Sku.description
   *   category    -> Product.categoryId (by name) when a Product exists, else Sku.category
   *   manufacturer-> ProductSourcing (creating the Manufacturer if new) + Sku.manufacturer
   *   price/cost/weight/group/active -> Sku (created on demand)
   */
  /**
   * Create one part, in one request, in one place.
   *
   * The mirror of the PATCH below, and the reason it exists: editing a part already
   * writes across `Product`, `Sku`, `ProductSourcing` and `Manufacturer` from a single
   * merged row, but CREATING one had no equivalent. A new part meant a POST to
   * /catalog/products for the catalog record and a separate POST to /skus for the priced
   * record, from two different screens — so a part could be, and routinely was, created
   * as half of itself. A Product with no Sku carries no price and quietly totals zero on
   * a proposal; a Sku with no Product has no category, no dimensions and no sourcing.
   *
   * Both rows, or neither. The whole thing is one interactive transaction, so a
   * validation failure on the second write cannot leave the first behind.
   *
   * The manufacturer must ALREADY EXIST
   * -----------------------------------
   * A name matching no `Manufacturer.name` is a 400 here, naming the ones that do exist.
   *
   * The PATCH below used to do the opposite — create a Manufacturer row for any
   * unrecognised name, with no address, no contact, no payment terms and none of the Bill
   * of Materials email defaults, which then sat in the vendor list looking exactly as
   * legitimate as the real ones. It no longer does; both paths refuse the same way. The
   * history is worth keeping because the damage it caused is still on record in this repo:
   * `src/handoff/vendorResolution.ts` was written because vendor identity lived in two
   * places and only one was read, and `prisma/fix-vendor-name.ts` and
   * `prisma/resync-order-vendors.ts` are both repair scripts for the aftermath.
   *
   * That is not a hypothetical. `src/handoff/vendorResolution.ts` exists because vendor
   * identity was recorded in two places and only one was read; there are two repair
   * scripts on disk (`prisma/fix-vendor-name.ts`, `prisma/resync-order-vendors.ts`); and
   * `bomSections.ts` carries an 'Unassigned vendor' fallback for lines the catalog cannot
   * attribute.
   *
   * So: a name that matches no `Manufacturer.name` is a 400 here, naming the ones that
   * do exist. Creating a vendor is an act with an address and payment terms attached to
   * it, and it belongs on the Manufacturers screen, not as a side effect of typing a part
   * number.
   *
   * The category is resolved the same way and for the same reason — by name, against
   * existing rows, refusing rather than inventing.
   */
  const ItemCreate = z.object({
    part: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(300),
    /** An existing ProductCategory name. Required: it is Product.categoryId, non-null. */
    category: z.string().trim().min(1).max(200),
    /** An existing Manufacturer name, or blank for "not sourced yet". */
    manufacturer: z.string().trim().max(200).optional(),
    unitPriceMinor: z.number().int().nonnegative().optional(),
    unitCostMinor: z.number().int().nonnegative().optional(),
    weightLbs: z.number().nonnegative().optional(),
    proposalGroup: z.string().trim().max(200).nullish(),
    active: z.boolean().optional(),
    /** Where it sits among its siblings in the product tree. */
    sortOrder: z.number().int().min(0).max(999999).optional(),
    /** Quantity the proposal builder seeds it with; null = no default. */
    defaultQty: z.number().int().min(0).max(9999).nullable().optional(),
  });

  app.post('/catalog/items', admin, async (req, reply) => {
    const parsed = ItemCreate.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid part');
    const d = parsed.data;
    const part = d.part.trim();

    // Both tables, because a part number already used by either one is taken. Checked
    // before the transaction so the message is about the clash rather than a constraint.
    const [dupeProduct, dupeSku] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part }, select: { id: true } }),
      prisma.sku.findUnique({ where: { part }, select: { id: true } }),
    ]);
    if (dupeProduct || dupeSku)
      throw new ConflictError(
        `Part number ${part} already exists in the catalog. Edit it from the catalog list instead.`,
      );

    const category = await prisma.productCategory.findFirst({
      where: { name: d.category },
      select: { id: true },
    });
    if (!category) throw new ValidationError(`No product category named “${d.category}”`);

    const wantsVendor = !!(d.manufacturer && d.manufacturer.trim());
    let manufacturer: { id: string; name: string } | null = null;
    if (wantsVendor) {
      const name = d.manufacturer!.trim();
      manufacturer = await prisma.manufacturer.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      if (!manufacturer) {
        // Name the real ones. "Unknown manufacturer" on its own sends the operator
        // looking for a spelling they have no way to guess.
        const known = await prisma.manufacturer.findMany({
          where: { isActive: true },
          select: { name: true },
          orderBy: { name: 'asc' },
          take: 60,
        });
        throw new ValidationError(
          `“${name}” is not a manufacturer on record, so this part would be sourced from ` +
            `a vendor that does not exist. Pick one of: ${known.map((m) => m.name).join(', ')}. ` +
            `To add a new vendor, use Administration → Manufacturers, where its address and ` +
            `payment terms can be entered.`,
        );
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: part,
          name: d.name,
          categoryId: category.id,
          sortOrder: d.sortOrder ?? 0,
          ...(d.defaultQty != null ? { defaultQuantity: d.defaultQty } : {}),
          // ACTIVE unless told otherwise: a part created from this form is one somebody
          // intends to quote. DRAFT would hide it from the builder with no hint why.
          status: d.active === false ? 'INACTIVE' : 'ACTIVE',
          createdById: req.user!.sub,
        },
      });

      const sku = await tx.sku.create({
        data: {
          part,
          description: d.name,
          // Sku.category is a part TYPE code (FRAME, TROLLEY, ACCESSORY) used for catalog
          // filtering and reporting — NOT the proposal heading, which is
          // `Sku.proposalGroup`, and not the tree position, which is Product.categoryId.
          // It is non-null, and a new part has nothing better to seed it with than the
          // section it was filed under, so that is the starting value; it is meant to be
          // edited to a real type afterwards.
          category: d.category,
          manufacturer: manufacturer ? manufacturer.name : null,
          unitPriceMinor: d.unitPriceMinor ?? 0,
          unitCostMinor: d.unitCostMinor ?? 0,
          weightLbs: d.weightLbs ?? 0,
          proposalGroup: (d.proposalGroup || '').trim() || null,
          active: d.active !== false,
          ...(d.defaultQty !== undefined ? { defaultQty: d.defaultQty } : {}),
        },
      });

      if (manufacturer)
        await tx.productSourcing.create({
          data: { productId: product.id, manufacturerId: manufacturer.id },
        });

      // The same version row POST /catalog/products writes, so a part created here has
      // the same history as one created there.
      await tx.productVersion.create({
        data: {
          productId: product.id,
          version: 1,
          snapshot: { ...d, part } as object,
          changedById: req.user!.sub,
          changeNote: 'created from the catalog list',
        },
      });

      return { product, sku };
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.item.create',
      entity: 'Product',
      entityId: created.product.id,
    });
    // Same shape the PATCH below uses, so a part created here and a part edited here
    // produce comparable rows in the revision log. `label` carries the part number as it
    // read at the time, which is what makes the row survive a later rename.
    await recordRevision({
      entity: 'Sku',
      entityId: created.sku.id,
      label: part,
      action: 'create',
      actorId: req.user!.sub,
      after: skuSnapshot(created.sku as unknown as Record<string, unknown>),
    });

    return reply.status(201).send({
      part,
      productId: created.product.id,
      skuId: created.sku.id,
      manufacturer: manufacturer ? manufacturer.name : null,
    });
  });

  app.patch('/catalog/items/:part', admin, async (req) => {
    const { part } = req.params as { part: string };
    const parsed = ItemPatch.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid item');
    const d = parsed.data;

    const product = await prisma.product.findUnique({ where: { sku: part } });
    let sku = await prisma.sku.findUnique({ where: { part } });

    const needsSku =
      d.unitPriceMinor !== undefined ||
      d.unitCostMinor !== undefined ||
      d.weightLbs !== undefined ||
      d.proposalGroup !== undefined ||
      d.active !== undefined ||
      d.manufacturer !== undefined ||
      d.overrideAllowed !== undefined ||
      d.defaultQty !== undefined ||
      d.freightMinor !== undefined ||
      d.freightLabel !== undefined ||
      d.productUrl !== undefined ||
      d.requiresPowderColor !== undefined ||
      d.packagingBag !== undefined ||
      (d.name !== undefined && !product) ||
      (d.category !== undefined && !product);
    if (!sku && needsSku) {
      sku = await prisma.sku.create({
        data: {
          part,
          description: d.name || product?.name || part,
          category: (!product && d.category) || 'OTHER',
        },
      });
    }

    if (d.name !== undefined) {
      if (product)
        await prisma.product.update({ where: { id: product.id }, data: { name: d.name } });
      if (sku) await prisma.sku.update({ where: { id: sku.id }, data: { description: d.name } });
    }

    if (d.category !== undefined) {
      /*
       * The tree position, and ONLY the tree position, when a Product exists.
       *
       * I briefly changed this to also write `Sku.category`, believing the two held the
       * same fact and drifted. They do not. `Product.categoryId` is where the part sits
       * in the catalog tree; `Sku.category` is a part TYPE — FRAME, TROLLEY, ACCESSORY —
       * used for catalog filtering and reporting, and the proposal heading is a third
       * field again, `Sku.proposalGroup`. Writing the tree's section name over the type
       * code destroyed a deliberate taxonomy on every section edit.
       *
       * The `else if` is therefore right: a part with a Product row keeps its type code,
       * and a part with only a priced row uses `Sku.category` as the nearest thing it has
       * to a classification.
       */
      if (product && d.category) {
        const cat = await prisma.productCategory.findFirst({ where: { name: d.category } });
        if (!cat) throw new ValidationError(`No product category named “${d.category}”`);
        await prisma.product.update({ where: { id: product.id }, data: { categoryId: cat.id } });
      } else if (sku) {
        await prisma.sku.update({
          where: { id: sku.id },
          data: { category: d.category || 'OTHER' },
        });
      }
    }

    if (d.manufacturer !== undefined) {
      const name = (d.manufacturer || '').trim();

      /*
       * Resolved BEFORE anything is written, and refused if it is not on record.
       *
       * This block used to do:
       *
       *     let mfr = await prisma.manufacturer.findFirst({ where: { name } });
       *     if (!mfr) mfr = await prisma.manufacturer.create({ data: { name, slug } });
       *
       * — so a mistyped vendor name CREATED a manufacturer. The new row had no address,
       * no contact, no payment terms and none of the Bill of Materials email defaults,
       * and it then sat in the vendor list looking exactly as legitimate as the real
       * ones. The part was sourced from a vendor that did not exist, and the first
       * anyone knew was a purchase order with nowhere to send it.
       *
       * The catalog screen now offers a dropdown, so it cannot send an unknown name. This
       * closes the endpoint itself, which the CSV importer and any other caller also use.
       *
       * The check comes FIRST, before the Sku write below, on purpose. Refusing at the
       * sourcing step — where the old creation happened — would leave Sku.manufacturer
       * already updated and ProductSourcing not, which is the two-records-disagreeing
       * state that `resync-order-vendors.ts` exists to repair. Nothing is written unless
       * the vendor is real.
       *
       * Matched case-insensitively, and the stored spelling wins, so "resilite" files the
       * part under "Resilite" rather than creating a second spelling of one vendor.
       */
      let mfr: { id: string; name: string } | null = null;
      if (name) {
        mfr = await prisma.manufacturer.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } },
          select: { id: true, name: true },
        });
        if (!mfr) {
          const known = await prisma.manufacturer.findMany({
            where: { isActive: true },
            select: { name: true },
            orderBy: { name: 'asc' },
            take: 60,
          });
          throw new ValidationError(
            `“${name}” is not a manufacturer on record, so this part would be sourced from ` +
              `a vendor that does not exist. Use one of: ${known.map((m) => m.name).join(', ')}. ` +
              `To add a new vendor, go to Catalog → Manufacturers, where its address and ` +
              `payment terms can be entered.`,
          );
        }
      }
      const canonical = mfr ? mfr.name : '';

      if (sku) {
        const before = sku.manufacturer ?? '';
        await prisma.sku.update({
          where: { id: sku.id },
          data: { manufacturer: canonical || null },
        });
        // Carry the change onto the open orders that still list this part under the
        // vendor it was bought from before.
        if (canonical && canonical !== before) {
          await reassignSkuVendor(sku.part, canonical, req.user!.sub);
        }
      }
      if (product) {
        if (!mfr) {
          await prisma.productSourcing.deleteMany({ where: { productId: product.id } });
        } else {
          const existing = await prisma.productSourcing.findFirst({
            where: { productId: product.id },
          });
          if (existing)
            await prisma.productSourcing.update({
              where: { id: existing.id },
              data: { manufacturerId: mfr.id },
            });
          else
            await prisma.productSourcing.create({
              data: { productId: product.id, manufacturerId: mfr.id },
            });
        }
      }
    }

    if (sku) {
      const money: Record<string, unknown> = {};
      if (d.unitPriceMinor !== undefined) money.unitPriceMinor = d.unitPriceMinor;
      if (d.unitCostMinor !== undefined) money.unitCostMinor = d.unitCostMinor;
      if (d.weightLbs !== undefined) money.weightLbs = d.weightLbs;
      if (d.proposalGroup !== undefined) money.proposalGroup = d.proposalGroup || null;
      if (d.active !== undefined) money.active = d.active;
      if (d.overrideAllowed !== undefined) money.overrideAllowed = d.overrideAllowed;
      if (d.defaultQty !== undefined) money.defaultQty = d.defaultQty;
      if (d.freightMinor !== undefined) money.freightMinor = d.freightMinor;
      if (d.freightLabel !== undefined) money.freightLabel = (d.freightLabel || '').trim() || null;
      // Validated here as well as in the browser: a mistyped link becomes an
      // unclickable "Buy" button on a purchasing document.
      if (d.productUrl !== undefined) {
        const u = (d.productUrl || '').trim();
        if (u && !/^https?:\/\//i.test(u))
          throw new ValidationError('A buy link must start with http:// or https://');
        money.productUrl = u || null;
      }
      if (d.requiresPowderColor !== undefined) money.requiresPowderColor = d.requiresPowderColor;
      // Bag numbers are typed by hand on about thirty hardware items; a blank
      // clears the label rather than storing an empty string.
      if (d.packagingBag !== undefined) money.packagingBag = (d.packagingBag || '').trim() || null;
      if (Object.keys(money).length)
        await prisma.sku.update({ where: { id: sku.id }, data: money });
    }

    // A cost edit also lands in the dated cost history, so pricing/service.ts and
    // the workbook's cost trail stay in step with the flat SKU record.
    if (d.unitCostMinor !== undefined && product) {
      await prisma.productCost.create({
        data: {
          productId: product.id,
          unitCost: BigInt(d.unitCostMinor),
          currency: 'USD',
          effectiveDate: new Date(),
          createdById: req.user!.sub,
        },
      });
    }

    // The item editor writes across Sku, Product and ProductCost; the SKU record is
    // the one the bill of materials prices from, so that is what the history keeps.
    const afterSku = await prisma.sku.findUnique({ where: { part } });
    if (afterSku) {
      await recordRevision({
        entity: 'Sku',
        entityId: afterSku.id,
        label: part,
        action: 'update',
        actorId: req.user!.sub,
        before: sku ? skuSnapshot(sku as unknown as Record<string, unknown>) : null,
        after: skuSnapshot(afterSku as unknown as Record<string, unknown>),
      });
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.item.update',
      entity: 'Sku',
      entityId: part,
      details: d as Record<string, unknown>,
    });
    return { ok: true, part };
  });

  /**
   * How many saved proposals reference this part. Proposal items are JSON, so this
   * scans them — the volume is small and the answer is what makes a delete safe.
   */
  async function proposalUsage(part: string): Promise<{ count: number; numbers: string[] }> {
    const versions = await prisma.proposalVersion.findMany({
      select: { items: true, proposal: { select: { number: true } } },
    });
    const numbers = new Set<string>();
    for (const v of versions) {
      const items = Array.isArray(v.items) ? (v.items as { sku?: string; name?: string }[]) : [];
      if (items.some((i) => i && (i.sku === part || i.name === part)))
        numbers.add(v.proposal.number);
    }
    return { count: numbers.size, numbers: [...numbers].slice(0, 5) };
  }

  /**
   * Part → its builder defaults, for the proposal builder to apply on add. A small
   * dedicated payload: the builder needs this on every line insert and should not
   * pull the whole 300-row catalog to get it.
   *
   * Price, cost and weight are included for EVERY active part, not just parts with a
   * default. The builder snapshots a line's price when the line is inserted — which
   * is right, because a saved proposal must not silently re-price itself — but that
   * meant a part priced in the catalog AFTER a proposal was built stayed at $0.00
   * with nothing on screen saying so. The builder now uses these to flag a
   * zero-priced line and to re-pull catalog figures on request.
   */
  app.get('/catalog/items/defaults', read, async () => {
    // Same three sources, and the same precedence, as GET /catalog/items above: the
    // Sku row owns money, and where it carries none the workbook's dated cost history
    // and the Product's ounce weight stand in. Reading Sku alone was the bug — parts
    // whose cost lives only in ProductCost (the Pediasuit belts, among others) showed
    // a cost in the catalog and inserted onto a proposal at 0, taking the line to 100%
    // margin. Whatever the catalog shows, the builder now inserts.
    const [rows, products, costs, freightTbdMfrs, sourcing, categories] = await Promise.all([
      listSkus(),
      prisma.product.findMany({
        select: {
          id: true,
          sku: true,
          name: true,
          status: true,
          weightOz: true,
          sortOrder: true,
          categoryId: true,
        },
      }),
      prisma.productCost.findMany({
        select: { productId: true, unitCost: true, effectiveDate: true },
        orderBy: { effectiveDate: 'desc' },
      }),
      // Vendors that quote freight after the fact. Their parts carry a standing note
      // on the proposal line until a freight figure is entered.
      prisma.manufacturer.findMany({
        where: { freightTbd: true },
        select: { id: true, name: true },
      }),
      prisma.productSourcing.findMany({ select: { productId: true, manufacturerId: true } }),
      prisma.productCategory.findMany({
        select: { id: true, name: true, parentId: true, sortOrder: true },
      }),
    ]);

    /**
     * Catalogue position as one comparable string, so the builder can drop a part
     * into its right place without knowing the category tree.
     *
     * The key is the category's ancestry by sortOrder, then the product's own
     * sortOrder, then the part number. Numbers are zero-padded because the builder
     * compares these lexically — "10" must not sort before "9".
     *
     * Parts carried only as a Sku row have no tree position at all. They get a "z"
     * prefix and sort after everything placed, by category name then part, which is
     * the same order the catalog list shows them in.
     */
    const catById = new Map(categories.map((c) => [c.id, c]));
    const pad = (n: number): string => String(Math.max(0, Math.round(n))).padStart(5, '0');
    const catPathKey = (categoryId: string | null | undefined): string | null => {
      const path: string[] = [];
      let node = categoryId ? catById.get(categoryId) : undefined;
      // Depth guard: a self-referencing parentId would otherwise spin forever.
      for (let hops = 0; node && hops < 12; hops++) {
        path.unshift(pad(node.sortOrder));
        node = node.parentId ? catById.get(node.parentId) : undefined;
      }
      return path.length ? path.join('.') : null;
    };
    /**
     * The category ancestry as names, outermost first — e.g.
     * ["THERAPEUTIC ACTIVITY & ADVENTURE COMPONENTS", "Therapeutic Swing & Sensory
     * Equipment Package"]. The builder turns the first into the proposal's group
     * heading and the last into its sub-heading, creating either if the proposal does
     * not have it yet, so a picked part lands in the right place on a bare proposal.
     * Empty for a part carried only as a Sku row: nothing places it, so it appends.
     */
    const catPathNames = (categoryId: string | null | undefined): string[] => {
      const names: string[] = [];
      let node = categoryId ? catById.get(categoryId) : undefined;
      for (let hops = 0; node && hops < 12; hops++) {
        names.unshift(node.name);
        node = node.parentId ? catById.get(node.parentId) : undefined;
      }
      return names;
    };
    const sortKeyFor = (
      part: string,
      product?: { sortOrder: number; categoryId: string },
      skuCategory?: string | null,
    ): string => {
      const tree = product ? catPathKey(product.categoryId) : null;
      if (tree) return tree + '|' + pad(product!.sortOrder) + '|' + part;
      return 'z|' + String(skuCategory || '').toLowerCase() + '|' + part;
    };
    const latestCost: Record<string, number> = {};
    for (const c of costs)
      if (latestCost[c.productId] === undefined) latestCost[c.productId] = Number(c.unitCost);
    const productByPart = new Map(products.map((p) => [p.sku, p]));
    const lbsFromOz = (oz: number | null | undefined): number =>
      oz ? Math.round((oz / 16) * 1000) / 1000 : 0;

    // A part reaches its vendor two ways — by name on the flat SKU master, or through
    // ProductSourcing. Both are checked, because the catalog is populated by both.
    const tbdNames = new Set(freightTbdMfrs.map((m) => m.name.trim().toLowerCase()));
    const tbdIds = new Set(freightTbdMfrs.map((m) => m.id));
    const tbdProductIds = new Set(
      sourcing.filter((s) => tbdIds.has(s.manufacturerId)).map((s) => s.productId),
    );
    const freightTbdFor = (manufacturer?: string | null, productId?: string): boolean => {
      if (manufacturer && tbdNames.has(manufacturer.trim().toLowerCase())) return true;
      return !!productId && tbdProductIds.has(productId);
    };

    type Entry = {
      qty?: number;
      freightMinor?: number;
      freightLabel?: string;
      freightTbd?: boolean;
      priceMinor?: number;
      costMinor?: number;
      weightLbs?: number;
      description?: string;
      /** Catalogue position — see sortKeyFor above. Drives insertion order in the builder. */
      sortKey?: string;
      category?: string;
      /** Category ancestry, outermost first — see catPathNames above. */
      path?: string[];
    };
    const out: Record<string, Entry> = {};
    for (const s of rows) {
      if (!s.active) continue;
      const p = productByPart.get(s.part);
      const entry: Entry = {};
      if (s.defaultQty != null) entry.qty = s.defaultQty;
      if (s.freightMinor != null) entry.freightMinor = s.freightMinor;
      if (s.freightLabel) entry.freightLabel = s.freightLabel;
      entry.priceMinor = s.unitPriceMinor || 0;
      entry.costMinor = s.unitCostMinor || (p ? latestCost[p.id] || 0 : 0);
      entry.weightLbs = Number(s.weightLbs) || (p ? lbsFromOz(p.weightOz) : 0);
      entry.description = s.description;
      entry.sortKey = sortKeyFor(
        s.part,
        p ? { sortOrder: p.sortOrder, categoryId: p.categoryId } : undefined,
        s.category,
      );
      entry.category = (p ? catById.get(p.categoryId)?.name : null) || s.category || '';
      entry.path = p ? catPathNames(p.categoryId) : [];
      if (freightTbdFor(s.manufacturer, p?.id)) entry.freightTbd = true;
      out[s.part] = entry;
    }
    // Parts that exist as a Product but were never given a Sku row still have a cost
    // and a weight worth applying. No price, so the builder's zero-price warning goes
    // on flagging them.
    for (const p of products) {
      if (out[p.sku] || p.status !== 'ACTIVE') continue;
      out[p.sku] = {
        priceMinor: 0,
        costMinor: latestCost[p.id] || 0,
        weightLbs: lbsFromOz(p.weightOz),
        description: p.name,
        sortKey: sortKeyFor(p.sku, { sortOrder: p.sortOrder, categoryId: p.categoryId }),
        category: catById.get(p.categoryId)?.name || '',
        path: catPathNames(p.categoryId),
        ...(freightTbdFor(null, p.id) ? { freightTbd: true } : {}),
      };
    }
    return out;
  });

  /**
   * Parts that exist in the SKU master and nowhere in the product tree.
   *
   * The two are separate tables joined only by the part-number string: a `Sku` row
   * carries cost, weight and vendor, a `Product` row carries a category and a place in
   * the tree, and nothing creates one from the other. A part with only a `Sku` row is
   * therefore invisible where somebody would choose it and fully functional where it is
   * purchased — it resolves cost, weight and vendor perfectly well when a component
   * rule, a kit expansion or a hand-added line puts it on an order.
   *
   * Those parts are exactly the ones that can appear on a Bill of Materials without
   * ever having appeared on a proposal, so they are worth being able to list. Each row
   * says where the part is already being used, which is what tells a real gap (a part
   * that should be on the tree) apart from a deliberate purchasing-only part.
   */
  app.get('/catalog/sku-only', read, async () => {
    const [skus, products] = await Promise.all([
      prisma.sku.findMany({
        select: {
          part: true,
          description: true,
          manufacturer: true,
          unitCostMinor: true,
          weightLbs: true,
          active: true,
        },
        orderBy: { part: 'asc' },
      }),
      prisma.product.findMany({ select: { sku: true } }),
    ]);

    // Matched case-insensitively, the same way every other part lookup in this
    // application does it — 'a-2207' and 'A-2207' are one part.
    const inTree = new Set(
      products
        .map((p) =>
          String(p.sku ?? '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    );
    const orphans = skus.filter((s) => !inTree.has(s.part.trim().toUpperCase()));
    if (!orphans.length) return { count: 0, rows: [] };

    const parts = orphans.map((s) => s.part);
    const [asChild, asParent, onOrders] = await Promise.all([
      prisma.skuComponent.findMany({
        where: { childPart: { in: parts, mode: 'insensitive' } },
        select: { parentPart: true, childPart: true, quantity: true },
      }),
      prisma.skuComponent.findMany({
        where: { parentPart: { in: parts, mode: 'insensitive' } },
        select: { parentPart: true, childPart: true },
      }),
      prisma.procurementLine.groupBy({
        by: ['sku'],
        where: { sku: { in: parts, mode: 'insensitive' } },
        _count: { _all: true },
      }),
    ]);

    const key = (v: unknown) =>
      String(v ?? '')
        .trim()
        .toUpperCase();
    const childOf = new Map<string, string[]>();
    for (const r of asChild) {
      const k = key(r.childPart);
      childOf.set(k, (childOf.get(k) ?? []).concat(r.parentPart));
    }
    const parentOf = new Map<string, string[]>();
    for (const r of asParent) {
      const k = key(r.parentPart);
      parentOf.set(k, (parentOf.get(k) ?? []).concat(r.childPart));
    }
    const orderCount = new Map<string, number>();
    for (const r of onOrders) orderCount.set(key(r.sku), r._count._all);

    return {
      count: orphans.length,
      rows: orphans.map((s) => {
        const k = key(s.part);
        return {
          part: s.part,
          description: s.description ?? '',
          vendor: s.manufacturer ?? null,
          unitCostMinor: s.unitCostMinor ?? null,
          weightLbs: s.weightLbs == null ? null : Number(s.weightLbs),
          active: s.active,
          /** Part numbers whose component list pulls this part onto a sheet. */
          componentOf: childOf.get(k) ?? [],
          /** Parts this one is declared as being made of. */
          explodesInto: parentOf.get(k) ?? [],
          /** How many order lines already carry it. */
          orderLines: orderCount.get(k) ?? 0,
        };
      }),
    };
  });
  /** What deleting this part would remove, and whether it is safe. */
  app.get('/catalog/items/:part/usage', read, async (req) => {
    const { part } = req.params as { part: string };
    const [product, sku, usage] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part }, select: { id: true, status: true } }),
      prisma.sku.findUnique({ where: { part }, select: { id: true, active: true } }),
      proposalUsage(part),
    ]);
    const everActive = product
      ? (await prisma.productStatusHistory.count({
          where: { productId: product.id, toStatus: 'ACTIVE' },
        })) > 0
      : false;
    return {
      part,
      hasProduct: !!product,
      hasSku: !!sku,
      productStatus: product?.status ?? null,
      active: sku ? sku.active : product?.status === 'ACTIVE',
      proposalCount: usage.count,
      proposalNumbers: usage.numbers,
      deletable: usage.count === 0 && !everActive,
      reason:
        usage.count > 0
          ? `Used on ${usage.count} proposal${usage.count === 1 ? '' : 's'} (${usage.numbers.join(', ')}${usage.count > usage.numbers.length ? '…' : ''}) — deactivate it instead so historical proposals keep their pricing.`
          : everActive
            ? 'This product has been active, so its history is kept — deactivate or archive it instead.'
            : null,
    };
  });

  /**
   * Delete a catalog part outright — both the Product record and the flat Sku row.
   * Refused when a proposal references the part or the product was ever ACTIVE:
   * deleting then would silently change historical documents. Deactivate instead.
   */
  app.delete('/catalog/items/:part', admin, async (req, reply) => {
    const { part } = req.params as { part: string };
    const [product, sku, usage] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part } }),
      prisma.sku.findUnique({ where: { part } }),
      proposalUsage(part),
    ]);
    if (!product && !sku) throw new NotFoundError('No catalog part with that number');
    if (usage.count > 0) {
      throw new ConflictError(
        `“${part}” is used on ${usage.count} proposal${usage.count === 1 ? '' : 's'} (${usage.numbers.join(', ')}). Deactivate it instead — deleting would change what those proposals priced.`,
      );
    }
    if (product) {
      const everActive = await prisma.productStatusHistory.count({
        where: { productId: product.id, toStatus: 'ACTIVE' },
      });
      if (everActive > 0)
        throw new ConflictError(
          `“${part}” has been an active product, so its record is kept for history. Archive or deactivate it instead.`,
        );
    }
    await prisma.$transaction(async (tx) => {
      if (sku) await tx.sku.delete({ where: { id: sku.id } });
      if (product) {
        await tx.productCost.deleteMany({ where: { productId: product.id } });
        await tx.productSourcing.deleteMany({ where: { productId: product.id } });
        await tx.product.delete({ where: { id: product.id } });
      }
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'catalog.item.delete',
      entity: 'Sku',
      entityId: part,
      details: { hadProduct: !!product, hadSku: !!sku },
    });
    reply.code(204);
    return null;
  });

  /**
   * Deactivate / reactivate a part in one call: the flat Sku row's `active` flag and
   * the Product status workflow move together, so an inactive part stops being
   * offered in the builder while every existing proposal keeps its pricing.
   */
  app.post('/catalog/items/:part/active', admin, async (req) => {
    const { part } = req.params as { part: string };
    const body = (req.body || {}) as { active?: boolean };
    if (typeof body.active !== 'boolean') throw new ValidationError('active must be true or false');
    const [product, sku] = await Promise.all([
      prisma.product.findUnique({ where: { sku: part } }),
      prisma.sku.findUnique({ where: { part } }),
    ]);
    if (!product && !sku) throw new NotFoundError('No catalog part with that number');
    if (sku) await prisma.sku.update({ where: { id: sku.id }, data: { active: body.active } });
    if (product) {
      const to = body.active ? 'ACTIVE' : 'INACTIVE';
      if (product.status !== to) {
        await prisma.product.update({ where: { id: product.id }, data: { status: to } });
        await prisma.productStatusHistory.create({
          data: {
            productId: product.id,
            fromStatus: product.status,
            toStatus: to,
            reason: 'catalog list',
            changedById: req.user!.sub,
          },
        });
      }
    }
    await recordAudit({
      actorId: req.user!.sub,
      action: body.active ? 'catalog.item.activate' : 'catalog.item.deactivate',
      entity: 'Sku',
      entityId: part,
    });
    return { part, active: body.active };
  });
}

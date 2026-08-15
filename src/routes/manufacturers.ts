import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { parseVendorPartPaste } from '../handoff/vendorParts.js';

/**
 * Manufacturers — the vendor of record.
 *
 * Until now a manufacturer was created as a side effect of typing a name into
 * the Catalog's manufacturer cell, so it had a name and nothing else. This is
 * the real record: address, point of contact, terms, account number. Two things
 * read it:
 *   * the Bill of Materials, which prints the vendor as the "Ship from" block;
 *   * the steel-weight total, which sums only lines from steel fabricators.
 *
 * A manufacturer is never hard-deleted while parts point at it — that would
 * orphan sourcing and silently blank the vendor on historical BOMs. Deactivate
 * instead; inactive vendors stop being offered but keep every existing link.
 */

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const str = (max: number) => z.string().trim().max(max).nullish();

const MfrInput = z.object({
  name: z.string().trim().min(2).max(160),
  contactName: str(160),
  contactTitle: str(120),
  contactEmail: z.union([z.string().trim().email(), z.literal('')]).nullish(),
  contactPhone: str(40),
  altContactName: str(160),
  altContactEmail: z.union([z.string().trim().email(), z.literal('')]).nullish(),
  altContactPhone: str(40),
  addressLine1: str(200),
  addressLine2: str(200),
  city: str(120),
  region: str(80),
  postalCode: str(20),
  country: str(80),
  website: str(200),
  accountNumber: str(80),
  paymentTerms: str(80),
  defaultLeadTimeDays: z.number().int().nonnegative().max(3650).nullish(),
  isThirdParty: z.boolean().optional(),
  isSteelFabricator: z.boolean().optional(),
  /** Parts from this vendor carry the freight-to-be-determined note on proposals. */
  freightTbd: z.boolean().optional(),
  /** Short code on this vendor's freight RFQ references — "RFQ-12414494509-SE". */
  rfqAbbrev: str(8),
  // Bill of Materials email defaults — pre-fill the send dialog for this vendor.
  bomEmailTo: str(300),
  bomEmailCc: str(400),
  bomEmailSubject: str(300),
  bomEmailBody: z.string().max(8000).nullish(),
  bomEmailFormat: z.enum(['EXCEL', 'PDF', 'BOTH']).optional(),
  /**
   * Which freight figure on the deal this vendor's shipment is quoted from. The
   * mats ship on their own line; everything else rides the structure figure.
   */
  bomFreightSource: z.enum(['STRUCTURE', 'MATS', 'NONE']).optional(),
  // ---- Request for Freight ----
  // Only flagged vendors are offered as RFQ recipients on a proposal, and the
  // freight desk is kept apart from the purchasing contact the BOM goes to.
  rfqEnabled: z.boolean().optional(),
  rfqContactName: str(160),
  rfqContactEmail: str(300),
  rfqContactPhone: str(60),
  rfqEmailTo: str(300),
  rfqEmailCc: str(400),
  rfqEmailSubject: str(300),
  rfqEmailBody: z.string().max(8000).nullish(),
  isActive: z.boolean().optional(),
  notes: str(2000),
});
const MfrUpdate = MfrInput.partial();

/** Empty strings arrive from blank form fields; store them as NULL. */
function clean<T extends Record<string, unknown>>(d: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d))
    out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
  return out as T;
}

export function registerManufacturerRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  /**
   * Every manufacturer with the number of catalog parts sourced from it, so the
   * list can show reach at a glance and warn before a delete.
   */
  app.get('/manufacturers', read, async (req) => {
    const { q = '', includeInactive = '' } = req.query as Record<string, string>;
    const term = q.trim().toLowerCase();
    const rows = await prisma.manufacturer.findMany({
      where: includeInactive === 'true' ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { sourcing: true } } },
    });
    // Parts can also be attached by name on the flat SKU master, which is the
    // only link generated frame/hardware lines have. Count both.
    const skuCounts = await prisma.sku.groupBy({ by: ['manufacturer'], _count: { _all: true } });
    const byName = new Map<string, number>();
    for (const s of skuCounts)
      if (s.manufacturer) byName.set(s.manufacturer.toLowerCase(), s._count._all);

    return rows
      .map(({ _count, ...m }) => ({
        ...m,
        productCount: _count.sourcing,
        skuCount: byName.get(m.name.toLowerCase()) ?? 0,
      }))
      .filter(
        (m) =>
          !term ||
          m.name.toLowerCase().includes(term) ||
          (m.city || '').toLowerCase().includes(term) ||
          (m.contactName || '').toLowerCase().includes(term),
      );
  });

  /** One manufacturer plus the parts sourced from it — the vendor's own part list. */
  app.get('/manufacturers/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const m = await prisma.manufacturer.findUnique({ where: { id } });
    if (!m) throw new NotFoundError('Manufacturer not found');
    const [sourced, skus] = await Promise.all([
      prisma.productSourcing.findMany({
        where: { manufacturerId: id },
        select: {
          vendorPartNo: true,
          leadTimeDays: true,
          minOrderQty: true,
          product: { select: { id: true, sku: true, name: true, status: true } },
        },
      }),
      prisma.sku.findMany({
        where: { manufacturer: m.name },
        select: {
          part: true,
          description: true,
          unitCostMinor: true,
          weightLbs: true,
          active: true,
        },
      }),
    ]);
    const parts = new Map<
      string,
      {
        part: string;
        name: string;
        vendorPartNo: string | null;
        unitCostMinor: number;
        weightLbs: number;
        active: boolean;
      }
    >();
    for (const s of skus) {
      parts.set(s.part, {
        part: s.part,
        name: s.description,
        vendorPartNo: null,
        unitCostMinor: s.unitCostMinor,
        weightLbs: Number(s.weightLbs),
        active: s.active,
      });
    }
    for (const s of sourced) {
      const existing = parts.get(s.product.sku);
      if (existing) existing.vendorPartNo = s.vendorPartNo ?? existing.vendorPartNo;
      else
        parts.set(s.product.sku, {
          part: s.product.sku,
          name: s.product.name,
          vendorPartNo: s.vendorPartNo ?? null,
          unitCostMinor: 0,
          weightLbs: 0,
          active: s.product.status === 'ACTIVE',
        });
    }
    // What this vendor calls parts we number ourselves. Not merged into `parts`
    // above: those are catalog rows, and the mat numbers this maps have none.
    const vendorParts = await prisma.vendorPartNumber.findMany({
      where: { manufacturerId: id },
      orderBy: { ourPart: 'asc' },
    });

    return {
      ...m,
      parts: [...parts.values()].sort((a, b) => a.part.localeCompare(b.part)),
      vendorParts,
    };
  });

  // ---------------- Vendor part numbers ----------------
  //
  // What the vendor calls a part we sell under our own number. Kept per vendor and
  // per part, printed on the Bill of Materials only — a proposal never reads it.
  // See src/handoff/vendorParts.ts for how a BOM resolves them.

  const VendorPartInput = z.object({
    ourPart: z.string().trim().min(1).max(80),
    vendorPart: z.string().trim().min(1).max(80),
    description: str(300),
    active: z.boolean().optional(),
  });

  async function requireManufacturer(id: string) {
    const m = await prisma.manufacturer.findUnique({ where: { id } });
    if (!m) throw new NotFoundError('Manufacturer not found');
    return m;
  }

  app.get('/manufacturers/:id/vendor-parts', read, async (req) => {
    const { id } = req.params as { id: string };
    await requireManufacturer(id);
    return prisma.vendorPartNumber.findMany({
      where: { manufacturerId: id },
      orderBy: { ourPart: 'asc' },
    });
  });

  app.post('/manufacturers/:id/vendor-parts', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await requireManufacturer(id);
    const parsed = VendorPartInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid vendor part number');
    const d = parsed.data;
    const ourPart = d.ourPart.toUpperCase();

    // One number per part per vendor: a second mapping would make which one prints
    // a matter of query order.
    const dupe = await prisma.vendorPartNumber.findFirst({
      where: { manufacturerId: id, ourPart: { equals: ourPart, mode: 'insensitive' } },
    });
    if (dupe)
      throw new ConflictError(
        `${m.name} already has a number for ${ourPart} (${dupe.vendorPart}). Edit that row instead.`,
      );

    const row = await prisma.vendorPartNumber.create({
      data: {
        manufacturerId: id,
        ourPart,
        vendorPart: d.vendorPart,
        description: d.description || null,
        active: d.active ?? true,
        createdById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.vendorPart.create',
      entity: 'VendorPartNumber',
      entityId: row.id,
      details: { vendor: m.name, ourPart, vendorPart: row.vendorPart },
    });
    return reply.status(201).send(row);
  });

  app.patch('/vendor-parts/:rowId', admin, async (req) => {
    const { rowId } = req.params as { rowId: string };
    const existing = await prisma.vendorPartNumber.findUnique({
      where: { id: rowId },
      include: { manufacturer: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundError('Vendor part number not found');
    const parsed = VendorPartInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid vendor part number');
    const d = parsed.data;
    const ourPart = d.ourPart ? d.ourPart.toUpperCase() : undefined;

    if (ourPart && ourPart !== existing.ourPart.toUpperCase()) {
      const dupe = await prisma.vendorPartNumber.findFirst({
        where: {
          manufacturerId: existing.manufacturerId,
          ourPart: { equals: ourPart, mode: 'insensitive' },
          id: { not: rowId },
        },
      });
      if (dupe)
        throw new ConflictError(
          `${existing.manufacturer.name} already has a number for ${ourPart}.`,
        );
    }

    const row = await prisma.vendorPartNumber.update({
      where: { id: rowId },
      data: {
        ...(ourPart ? { ourPart } : {}),
        ...(d.vendorPart !== undefined ? { vendorPart: d.vendorPart } : {}),
        ...(d.description !== undefined ? { description: d.description || null } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.vendorPart.update',
      entity: 'VendorPartNumber',
      entityId: rowId,
      details: { vendor: existing.manufacturer.name, ...d } as Record<string, unknown>,
    });
    return row;
  });

  app.delete('/vendor-parts/:rowId', admin, async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const existing = await prisma.vendorPartNumber.findUnique({
      where: { id: rowId },
      include: { manufacturer: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundError('Vendor part number not found');
    await prisma.vendorPartNumber.delete({ where: { id: rowId } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.vendorPart.delete',
      entity: 'VendorPartNumber',
      entityId: rowId,
      details: {
        vendor: existing.manufacturer.name,
        ourPart: existing.ourPart,
        vendorPart: existing.vendorPart,
      },
    });
    reply.code(204);
    return null;
  });

  /**
   * Paste a two-column list — our part, their part, optional description.
   *
   * A vendor with a number for every mat size has dozens of rows, and typing them
   * one at a time is how a mapping ends up half-loaded. `dryRun` returns what would
   * happen without writing, so the operator sees the count and the clashes before
   * committing.
   */
  app.post('/manufacturers/:id/vendor-parts/import', admin, async (req) => {
    const { id } = req.params as { id: string };
    const m = await requireManufacturer(id);
    const b = (req.body || {}) as { text?: string; dryRun?: boolean; overwrite?: boolean };
    const { rows, errors } = parseVendorPartPaste(b.text ?? '');
    if (!rows.length && !errors.length) throw new ValidationError('Nothing to import.');

    const existing = await prisma.vendorPartNumber.findMany({
      where: { manufacturerId: id },
      select: { id: true, ourPart: true, vendorPart: true },
    });
    const byPart = new Map(existing.map((r) => [r.ourPart.toUpperCase(), r]));

    const toCreate = rows.filter((r) => !byPart.has(r.ourPart));
    const toUpdate = rows.filter((r) => {
      const cur = byPart.get(r.ourPart);
      return !!cur && cur.vendorPart !== r.vendorPart;
    });
    const unchanged = rows.length - toCreate.length - toUpdate.length;

    if (b.dryRun) {
      return {
        dryRun: true,
        parsed: rows.length,
        created: toCreate.length,
        updated: b.overwrite ? toUpdate.length : 0,
        skipped: b.overwrite ? unchanged : unchanged + toUpdate.length,
        conflicts: b.overwrite
          ? []
          : toUpdate.map((r) => ({
              ourPart: r.ourPart,
              current: byPart.get(r.ourPart)!.vendorPart,
              incoming: r.vendorPart,
            })),
        errors,
      };
    }

    for (const r of toCreate) {
      await prisma.vendorPartNumber.create({
        data: {
          manufacturerId: id,
          ourPart: r.ourPart,
          vendorPart: r.vendorPart,
          description: r.description,
          createdById: req.user!.sub,
        },
      });
    }
    if (b.overwrite) {
      for (const r of toUpdate) {
        await prisma.vendorPartNumber.update({
          where: { id: byPart.get(r.ourPart)!.id },
          data: {
            vendorPart: r.vendorPart,
            ...(r.description ? { description: r.description } : {}),
          },
        });
      }
    }

    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.vendorPart.import',
      entity: 'Manufacturer',
      entityId: id,
      details: {
        vendor: m.name,
        created: toCreate.length,
        updated: b.overwrite ? toUpdate.length : 0,
        errors: errors.length,
      },
    });

    return {
      created: toCreate.length,
      updated: b.overwrite ? toUpdate.length : 0,
      skipped: b.overwrite ? unchanged : unchanged + toUpdate.length,
      errors,
    };
  });

  app.post('/manufacturers', admin, async (req, reply) => {
    const parsed = MfrInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid manufacturer');
    const d = clean(parsed.data);
    const dupe = await prisma.manufacturer.findFirst({
      where: { name: { equals: d.name, mode: 'insensitive' } },
    });
    if (dupe) throw new ConflictError(`“${d.name}” already exists`);
    let slug = slugify(d.name);
    if (await prisma.manufacturer.findUnique({ where: { slug } }))
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const m = await prisma.manufacturer.create({ data: { ...d, slug } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.create',
      entity: 'Manufacturer',
      entityId: m.id,
      details: { name: m.name },
    });
    return reply.status(201).send(m);
  });

  app.patch('/manufacturers/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = MfrUpdate.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid manufacturer');
    const current = await prisma.manufacturer.findUnique({ where: { id } });
    if (!current) throw new NotFoundError('Manufacturer not found');
    const d = clean(parsed.data);

    if (d.name && d.name !== current.name) {
      const dupe = await prisma.manufacturer.findFirst({
        where: { name: { equals: d.name, mode: 'insensitive' }, id: { not: id } },
      });
      if (dupe) throw new ConflictError(`“${d.name}” already exists`);
      // The flat SKU master stores the vendor by name, so a rename has to carry
      // there too or those parts silently lose their vendor on the next BOM.
      await prisma.sku.updateMany({
        where: { manufacturer: current.name },
        data: { manufacturer: d.name },
      });
    }
    const m = await prisma.manufacturer.update({ where: { id }, data: d });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.update',
      entity: 'Manufacturer',
      entityId: id,
      details: d as Record<string, unknown>,
    });
    return m;
  });

  /** What a delete would affect, and whether it is safe at all. */
  app.get('/manufacturers/:id/usage', read, async (req) => {
    const { id } = req.params as { id: string };
    const m = await prisma.manufacturer.findUnique({ where: { id } });
    if (!m) throw new NotFoundError('Manufacturer not found');
    const [sourcing, skus, procurement] = await Promise.all([
      prisma.productSourcing.count({ where: { manufacturerId: id } }),
      prisma.sku.count({ where: { manufacturer: m.name } }),
      prisma.procurementLine.count({ where: { vendor: m.name } }),
    ]);
    const deletable = sourcing === 0 && skus === 0 && procurement === 0;
    return {
      id,
      name: m.name,
      productCount: sourcing,
      skuCount: skus,
      orderLineCount: procurement,
      deletable,
      reason: deletable
        ? null
        : `${sourcing + skus} catalog part${sourcing + skus === 1 ? '' : 's'} and ${procurement} order line${procurement === 1 ? '' : 's'} reference this vendor — deactivate it instead so existing orders keep their vendor.`,
    };
  });

  app.delete('/manufacturers/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await prisma.manufacturer.findUnique({ where: { id } });
    if (!m) throw new NotFoundError('Manufacturer not found');
    const [sourcing, skus, procurement] = await Promise.all([
      prisma.productSourcing.count({ where: { manufacturerId: id } }),
      prisma.sku.count({ where: { manufacturer: m.name } }),
      prisma.procurementLine.count({ where: { vendor: m.name } }),
    ]);
    if (sourcing || skus || procurement) {
      throw new ConflictError(
        `“${m.name}” is used by ${sourcing + skus} catalog part(s) and ${procurement} order line(s). Deactivate it instead.`,
      );
    }
    await prisma.manufacturer.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'manufacturer.delete',
      entity: 'Manufacturer',
      entityId: id,
      details: { name: m.name },
    });
    reply.code(204);
    return null;
  });
}

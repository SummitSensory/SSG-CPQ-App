import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/errors.js';

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

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
  // Bill of Materials email defaults — pre-fill the send dialog for this vendor.
  bomEmailTo: str(300),
  bomEmailCc: str(400),
  bomEmailSubject: str(300),
  bomEmailBody: z.string().max(8000).nullish(),
  bomEmailFormat: z.enum(['EXCEL', 'PDF', 'BOTH']).optional(),
  isActive: z.boolean().optional(),
  notes: str(2000),
});
const MfrUpdate = MfrInput.partial();

/** Empty strings arrive from blank form fields; store them as NULL. */
function clean<T extends Record<string, unknown>>(d: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
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
    for (const s of skuCounts) if (s.manufacturer) byName.set(s.manufacturer.toLowerCase(), s._count._all);

    return rows
      .map(({ _count, ...m }) => ({ ...m, productCount: _count.sourcing, skuCount: byName.get(m.name.toLowerCase()) ?? 0 }))
      .filter((m) => !term || m.name.toLowerCase().includes(term) || (m.city || '').toLowerCase().includes(term) || (m.contactName || '').toLowerCase().includes(term));
  });

  /** One manufacturer plus the parts sourced from it — the vendor's own part list. */
  app.get('/manufacturers/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    const m = await prisma.manufacturer.findUnique({ where: { id } });
    if (!m) throw new NotFoundError('Manufacturer not found');
    const [sourced, skus] = await Promise.all([
      prisma.productSourcing.findMany({
        where: { manufacturerId: id },
        select: { vendorPartNo: true, leadTimeDays: true, minOrderQty: true, product: { select: { id: true, sku: true, name: true, status: true } } },
      }),
      prisma.sku.findMany({ where: { manufacturer: m.name }, select: { part: true, description: true, unitCostMinor: true, weightLbs: true, active: true } }),
    ]);
    const parts = new Map<string, { part: string; name: string; vendorPartNo: string | null; unitCostMinor: number; weightLbs: number; active: boolean }>();
    for (const s of skus) {
      parts.set(s.part, { part: s.part, name: s.description, vendorPartNo: null, unitCostMinor: s.unitCostMinor, weightLbs: Number(s.weightLbs), active: s.active });
    }
    for (const s of sourced) {
      const existing = parts.get(s.product.sku);
      if (existing) existing.vendorPartNo = s.vendorPartNo ?? existing.vendorPartNo;
      else parts.set(s.product.sku, { part: s.product.sku, name: s.product.name, vendorPartNo: s.vendorPartNo ?? null, unitCostMinor: 0, weightLbs: 0, active: s.product.status === 'ACTIVE' });
    }
    return { ...m, parts: [...parts.values()].sort((a, b) => a.part.localeCompare(b.part)) };
  });

  app.post('/manufacturers', admin, async (req, reply) => {
    const parsed = MfrInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid manufacturer');
    const d = clean(parsed.data);
    const dupe = await prisma.manufacturer.findFirst({ where: { name: { equals: d.name, mode: 'insensitive' } } });
    if (dupe) throw new ConflictError(`“${d.name}” already exists`);
    let slug = slugify(d.name);
    if (await prisma.manufacturer.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const m = await prisma.manufacturer.create({ data: { ...d, slug } });
    await recordAudit({ actorId: req.user!.sub, action: 'manufacturer.create', entity: 'Manufacturer', entityId: m.id, details: { name: m.name } });
    return reply.status(201).send(m);
  });

  app.patch('/manufacturers/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = MfrUpdate.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid manufacturer');
    const current = await prisma.manufacturer.findUnique({ where: { id } });
    if (!current) throw new NotFoundError('Manufacturer not found');
    const d = clean(parsed.data);

    if (d.name && d.name !== current.name) {
      const dupe = await prisma.manufacturer.findFirst({ where: { name: { equals: d.name, mode: 'insensitive' }, id: { not: id } } });
      if (dupe) throw new ConflictError(`“${d.name}” already exists`);
      // The flat SKU master stores the vendor by name, so a rename has to carry
      // there too or those parts silently lose their vendor on the next BOM.
      await prisma.sku.updateMany({ where: { manufacturer: current.name }, data: { manufacturer: d.name } });
    }
    const m = await prisma.manufacturer.update({ where: { id }, data: d });
    await recordAudit({ actorId: req.user!.sub, action: 'manufacturer.update', entity: 'Manufacturer', entityId: id, details: d as Record<string, unknown> });
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
      id, name: m.name, productCount: sourcing, skuCount: skus, orderLineCount: procurement, deletable,
      reason: deletable ? null
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
      throw new ConflictError(`“${m.name}” is used by ${sourcing + skus} catalog part(s) and ${procurement} order line(s). Deactivate it instead.`);
    }
    await prisma.manufacturer.delete({ where: { id } });
    await recordAudit({ actorId: req.user!.sub, action: 'manufacturer.delete', entity: 'Manufacturer', entityId: id, details: { name: m.name } });
    reply.code(204);
    return null;
  });
}

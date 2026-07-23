import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { recordAudit } from '../lib/audit.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';

const SkuBody = z.object({
  part: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  unitPriceMinor: z.number().int().nonnegative().default(0),
  weightLbs: z.number().nonnegative().default(0),
  category: z.string().trim().max(60).default('OTHER'),
  proposalGroup: z.string().trim().max(120).optional(),
  active: z.boolean().default(true),
});

// One import row; prices may arrive as dollars (unitPrice) or minor (unitPriceMinor).
const ImportRow = z.object({
  part: z.string().trim().min(1),
  description: z.string().trim().optional(),
  unitPrice: z.union([z.number(), z.string()]).optional(),
  unitPriceMinor: z.number().optional(),
  weightLbs: z.union([z.number(), z.string()]).optional(),
  category: z.string().trim().optional(),
  proposalGroup: z.string().trim().optional(),
});
const toMinor = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const num = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return isFinite(num) ? Math.round(num * 100) : 0;
};
const toNum = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const num = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return isFinite(num) ? num : 0;
};

/** SKU/pricing master: list, in-app editor CRUD, and bulk Excel/CSV import (upsert by part#). */
export function registerSkuRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CATALOG_READ) };
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/skus', read, async (req) => {
    const { q, category, page = '1', pageSize = '50' } = req.query as Record<string, string>;
    const where: Record<string, unknown> = {};
    if (q) where.OR = [
      { part: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
    if (category) where.category = category;
    const take = Math.min(500, parseInt(pageSize, 10) || 50);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;
    const [items, total] = await Promise.all([
      prisma.sku.findMany({ where, orderBy: { part: 'asc' }, take, skip }),
      prisma.sku.count({ where }),
    ]);
    return { items, total, page: parseInt(page, 10) || 1, pageSize: take };
  });

  app.post('/skus', admin, async (req, reply) => {
    const parsed = SkuBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.sku.findUnique({ where: { part: parsed.data.part } });
    if (existing) throw new ValidationError('A SKU with that part number already exists.');
    const sku = await prisma.sku.create({ data: { ...parsed.data, proposalGroup: parsed.data.proposalGroup ?? null } });
    await recordAudit({ actorId: req.user!.sub, action: 'sku.create', entity: 'Sku', entityId: sku.id });
    return reply.status(201).send(sku);
  });

  app.patch('/skus/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = SkuBody.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = await prisma.sku.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('SKU not found');
    const sku = await prisma.sku.update({ where: { id }, data: parsed.data });
    await recordAudit({ actorId: req.user!.sub, action: 'sku.update', entity: 'Sku', entityId: id });
    return sku;
  });

  app.delete('/skus/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.sku.delete({ where: { id } }).catch(() => { throw new NotFoundError('SKU not found'); });
    return reply.status(204).send();
  });

  // Bulk import: upsert rows by part#. dryRun returns a preview without writing.
  app.post('/skus/import', admin, async (req, reply) => {
    const body = z.object({ dryRun: z.boolean().default(false), rows: z.array(z.record(z.unknown())).min(1).max(5000) }).safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const issues: { row: number; message: string }[] = [];
    const clean: { part: string; description: string; unitPriceMinor: number; weightLbs: number; category: string; proposalGroup: string | null }[] = [];
    body.data.rows.forEach((raw, i) => {
      const p = ImportRow.safeParse(raw);
      if (!p.success) { issues.push({ row: i + 1, message: p.error.issues[0]?.message || 'invalid row' }); return; }
      const d = p.data;
      clean.push({
        part: d.part.trim(),
        description: (d.description || '').trim() || d.part.trim(),
        unitPriceMinor: d.unitPriceMinor != null ? Math.round(d.unitPriceMinor) : toMinor(d.unitPrice),
        weightLbs: toNum(d.weightLbs),
        category: (d.category || 'OTHER').trim(),
        proposalGroup: d.proposalGroup ? d.proposalGroup.trim() : null,
      });
    });
    if (body.data.dryRun) return { dryRun: true, valid: issues.length === 0, willUpsert: clean.length, issues };
    let created = 0, updated = 0;
    for (const c of clean) {
      const ex = await prisma.sku.findUnique({ where: { part: c.part } });
      if (ex) { await prisma.sku.update({ where: { part: c.part }, data: c }); updated++; }
      else { await prisma.sku.create({ data: c }); created++; }
    }
    await recordAudit({ actorId: req.user!.sub, action: 'sku.import', details: { created, updated } });
    return reply.status(201).send({ valid: issues.length === 0, created, updated, issues });
  });
}

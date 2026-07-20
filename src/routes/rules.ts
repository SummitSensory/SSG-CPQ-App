import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { RuleDefinitionInput } from '../rules/validation.js';
import { createRule, addRuleVersion, activateRule, retireRule, evaluate } from '../rules/service.js';
import { z } from 'zod';

const ConfigSchema = z.object({
  lines: z.array(z.object({
    productId: z.string().min(1),
    categoryId: z.string().optional(),
    kind: z.string().optional(),
    quantity: z.number().int().positive(),
  })).min(1),
  context: z.object({
    room: z.object({
      lengthIn: z.number().int().optional(),
      widthIn: z.number().int().optional(),
      ceilingHeightIn: z.number().int().optional(),
      clearanceIn: z.number().int().optional(),
    }).optional(),
    facts: z.record(z.unknown()).optional(),
    provided: z.array(z.string()).optional(),
  }).optional(),
  persist: z.boolean().default(false),
  subjectRef: z.string().optional(),
});

export function registerRuleRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.RULES_READ) };
  const manage = { preHandler: requirePermission(Permission.RULES_MANAGE) };

  // ----- Evaluate a configuration (read) -----
  app.post('/rules/evaluate', read, async (req) => {
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { persist, subjectRef, ...config } = parsed.data;
    return evaluate(config, req.user!.sub, { persist, subjectRef });
  });

  // ----- Admin: rule management (approved changes) -----
  app.get('/rules', manage, async () =>
    prisma.rule.findMany({ orderBy: { updatedAt: 'desc' }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } }),
  );

  app.post('/rules', manage, async (req, reply) => {
    const parsed = RuleDefinitionInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const rule = await createRule(parsed.data, req.user!.sub);
    return reply.status(201).send(rule);
  });

  app.post('/rules/:id/versions', manage, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = RuleDefinitionInput.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const version = await addRuleVersion(id, parsed.data, req.user!.sub, (req.body as { note?: string }).note);
    return { id, version };
  });

  // Activation is the "approved change" gate — cycle-checked before going live.
  app.post('/rules/:id/activate', manage, async (req) => {
    const { id } = req.params as { id: string };
    await activateRule(id, req.user!.sub);
    return { id, status: 'ACTIVE' };
  });

  app.post('/rules/:id/retire', manage, async (req) => {
    const { id } = req.params as { id: string };
    await retireRule(id, req.user!.sub);
    return { id, status: 'RETIRED' };
  });

  // Historical evaluation snapshots are read-only (protect historical configs).
  app.get('/rules/snapshots/:ref', read, async (req) => {
    const { ref } = req.params as { ref: string };
    return prisma.ruleEvaluationSnapshot.findMany({ where: { subjectRef: ref }, orderBy: { createdAt: 'desc' } });
  });
}

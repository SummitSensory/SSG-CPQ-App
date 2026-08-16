import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  DEFAULT_FOLLOW_UP_TEMPLATES,
  buildEml,
  defaultTemplateByKey,
  renderFollowUp,
  type FollowUpContext,
  type FollowUpTemplateData,
} from '../email/followUpTemplates.js';

/**
 * Proposal follow-up emails.
 *
 * The CRM writes the email; Outlook sends it. A draft is handed over either as a
 * mailto: link or as an .eml file, both of which arrive in Outlook already addressed
 * — see the draft route below for why there are two.
 *
 * Because the send happens in Outlook, the app cannot observe it. A log row is the
 * rep's assertion that they sent it, and the column is named `copiedAt` rather than
 * `sentAt` so nobody later mistakes it for a delivery receipt. It still answers the
 * question the rep actually has: which of the ten has this customer already had?
 *
 * History is per CUSTOMER. Two live proposals for one organization do not entitle it
 * to two copies of the same opening email.
 */

const LogInput = z.object({
  templateKey: z.string().trim().min(1).max(60),
  proposalId: z.string().trim().min(1).optional(),
  toEmail: z.string().trim().email(),
  toName: z.string().trim().max(160).optional(),
  /** The subject as it actually went out — the rep may have edited it. */
  subject: z.string().trim().min(1).max(300),
  note: z.string().trim().max(1000).optional(),
});

const TemplateInput = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, numbers and hyphens.'),
  name: z.string().trim().min(1).max(120),
  step: z.number().int().min(1).max(99),
  whenToSend: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(300),
  angle: z.string().trim().min(1).max(300),
  caution: z.string().trim().max(300).optional().nullable(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  active: z.boolean().optional(),
});

/**
 * Read the templates, seeding the table from code the first time.
 *
 * The seed runs on first read rather than in a migration because a migration cannot
 * import the templates, and keeping the wording in two places is how they drift.
 * `createMany` with `skipDuplicates` makes a concurrent first request harmless.
 */
async function loadTemplates(includeInactive = false): Promise<FollowUpTemplateData[]> {
  const count = await prisma.followUpTemplate.count();
  if (count === 0) {
    await prisma.followUpTemplate.createMany({
      data: DEFAULT_FOLLOW_UP_TEMPLATES.map((t) => ({
        key: t.key,
        name: t.name,
        step: t.step,
        whenToSend: t.whenToSend,
        objective: t.objective,
        angle: t.angle,
        caution: t.caution ?? null,
        subject: t.subject,
        body: t.body,
        isBuiltIn: true,
      })),
      skipDuplicates: true,
    });
  }
  const rows = await prisma.followUpTemplate.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ step: 'asc' }, { name: 'asc' }],
  });
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    step: r.step,
    whenToSend: r.whenToSend,
    objective: r.objective,
    angle: r.angle,
    caution: r.caution,
    subject: r.subject,
    body: r.body,
  }));
}

export function registerFollowUpRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CRM_READ) };
  const write = { preHandler: requirePermission(Permission.CRM_WRITE) };
  // Editing the templates is an administrative act — it changes what every rep sends.
  const manage = { preHandler: requirePermission(Permission.RULES_MANAGE) };

  /** Recipient and sender context for one customer, shared by the routes below. */
  async function contextFor(
    organizationId: string,
    userId: string,
    opts: { contactId?: string; proposalId?: string },
  ) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        contacts: {
          where: { email: { not: null } },
          orderBy: [{ isDecisionMaker: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            title: true,
            isDecisionMaker: true,
          },
        },
      },
    });
    if (!org) throw new NotFoundError('Customer not found');

    const proposal = opts.proposalId
      ? await prisma.proposal.findUnique({
          where: { id: opts.proposalId },
          select: { id: true, number: true, title: true },
        })
      : null;

    const sender = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    const contact =
      (opts.contactId ? org.contacts.find((c) => c.id === opts.contactId) : undefined) ??
      org.contacts[0];

    const senderFirst =
      String(sender?.name ?? '')
        .trim()
        .split(/\s+/)[0] ?? '';

    const ctx: FollowUpContext = {
      // The contact's own first-name field rather than splitting a display name, so
      // "Mary Beth" and "de la Cruz" both survive.
      firstName: contact?.firstName?.trim() || 'there',
      senderFirstName: senderFirst,
      customerName: org.name,
      proposalNumber: proposal?.number,
      proposalTitle: proposal?.title ?? undefined,
    };
    return { org, contact, ctx };
  }

  /** Every template, rendered for this customer, with its send history attached. */
  app.get('/crm/organizations/:organizationId/follow-ups', read, async (req) => {
    const { organizationId } = req.params as { organizationId: string };
    const q = req.query as { proposalId?: string; contactId?: string };
    const { org, contact, ctx } = await contextFor(organizationId, req.user!.sub, q);
    const templates = await loadTemplates();

    const history = await prisma.followUpEmailLog.findMany({
      where: { organizationId },
      orderBy: { copiedAt: 'desc' },
      take: 100,
    });
    const senderIds = [...new Set(history.map((h) => h.sentById))];
    const users = senderIds.length
      ? await prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return {
      customer: { id: org.id, name: org.name },
      contacts: org.contacts.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' '),
        email: c.email,
        title: c.title,
        isDecisionMaker: c.isDecisionMaker,
      })),
      selectedContactId: contact?.id ?? null,
      // Nothing is blocked. The rep sees when each template went and to whom and
      // decides — a hard block would be wrong the first time a project restarts a year
      // later or the contact changes.
      templates: templates.map((t) => {
        const rendered = renderFollowUp(t, ctx);
        const sent = history.filter((h) => h.templateKey === t.key);
        return {
          key: t.key,
          name: t.name,
          step: t.step,
          whenToSend: t.whenToSend,
          objective: t.objective,
          angle: t.angle,
          caution: t.caution ?? null,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          sentCount: sent.length,
          lastSent: sent[0]
            ? {
                copiedAt: sent[0].copiedAt,
                toName: sent[0].toName,
                toEmail: sent[0].toEmail,
                by: nameOf.get(sent[0].sentById) ?? null,
              }
            : null,
        };
      }),
      history: history.map((h) => ({
        id: h.id,
        templateKey: h.templateKey,
        templateName: h.templateName,
        step: h.step,
        subject: h.subject,
        toName: h.toName,
        toEmail: h.toEmail,
        copiedAt: h.copiedAt,
        by: nameOf.get(h.sentById) ?? null,
        note: h.note,
        proposalId: h.proposalId,
      })),
    };
  });

  /**
   * The email as an Outlook draft file.
   *
   * An .eml is the only way to hand Outlook a pre-filled message that keeps its
   * formatting: mailto: has no provision for HTML, so a mailto draft arrives as plain
   * text. The file carries `X-Unsent: 1` and no From header, which is what makes
   * Outlook open it as an editable draft addressed from the signed-in mailbox rather
   * than as a received message the rep has to forward.
   *
   * Rendered here rather than in the browser because the body is stored server-side
   * and quoted-printable encoding is fiddly enough that one implementation is enough.
   */
  app.get(
    '/crm/organizations/:organizationId/follow-ups/:key/draft.eml',
    read,
    async (req, reply) => {
      const { organizationId, key } = req.params as { organizationId: string; key: string };
      const q = req.query as { proposalId?: string; contactId?: string };
      const { contact, ctx } = await contextFor(organizationId, req.user!.sub, q);
      if (!contact?.email) throw new ValidationError('That contact has no email address.');

      const templates = await loadTemplates();
      const template = templates.find((t) => t.key === key);
      if (!template) throw new NotFoundError('Template not found');

      const rendered = renderFollowUp(template, ctx);
      const eml = buildEml({
        to: contact.email,
        toName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      const safe = `${template.step}-${template.key}`.replace(/[^A-Za-z0-9._-]+/g, '-');
      return reply
        .header('Content-Type', 'message/rfc822; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${safe}.eml"`)
        .send(eml);
    },
  );

  /** Record that a template went out. Called after the draft is handed over. */
  app.post('/crm/organizations/:organizationId/follow-ups', write, async (req, reply) => {
    const { organizationId } = req.params as { organizationId: string };
    const parsed = LogInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const d = parsed.data;

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    if (!org) throw new NotFoundError('Customer not found');

    const template =
      (await prisma.followUpTemplate.findUnique({ where: { key: d.templateKey } })) ??
      defaultTemplateByKey(d.templateKey);
    if (!template) throw new ValidationError('Unknown follow-up template');

    const row = await prisma.followUpEmailLog.create({
      data: {
        organizationId,
        proposalId: d.proposalId ?? null,
        templateKey: template.key,
        templateName: template.name,
        step: template.step,
        subject: d.subject,
        toName: d.toName ?? null,
        toEmail: d.toEmail,
        sentById: req.user!.sub,
        note: d.note ?? null,
      },
    });

    // Also written to the customer's note log, so the account history reads as one
    // timeline rather than making someone check two places.
    const sender = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    await prisma.customerNote
      .create({
        data: {
          organizationId,
          ...(d.proposalId ? { proposalId: d.proposalId } : {}),
          body: `Follow-up email ${template.step} — ${template.name} — sent to ${d.toName ?? d.toEmail} (${d.toEmail})`,
          authorId: req.user!.sub,
          authorName: sender?.name ?? sender?.email ?? 'Unknown',
        },
      })
      .catch(() => undefined);

    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.followUp.sent',
      entity: 'Organization',
      entityId: organizationId,
      details: { templateKey: template.key, step: template.step, to: d.toEmail },
    });

    return reply.status(201).send(row);
  });

  /**
   * Remove a history line. For a mis-click, not for tidying — the point of the log is
   * that it is complete, so the removal is audited.
   */
  app.delete('/follow-ups/:id', write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.followUpEmailLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Follow-up record not found');
    await prisma.followUpEmailLog.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'crm.followUp.deleted',
      entity: 'Organization',
      entityId: row.organizationId,
      details: { templateKey: row.templateKey, to: row.toEmail, copiedAt: row.copiedAt },
    });
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------------ admin */

  /**
   * The templates, for editing. Rendered against a sample recipient so the editor can
   * see what a placeholder actually produces without opening a real customer.
   */
  app.get('/admin/follow-up-templates', read, async () => {
    await loadTemplates();
    const rows = await prisma.followUpTemplate.findMany({
      orderBy: [{ step: 'asc' }, { name: 'asc' }],
    });
    const sample: FollowUpContext = {
      firstName: 'Emily',
      senderFirstName: 'Bryan',
      customerName: 'Uniquely Yours Specialized Care',
      proposalNumber: 'P-2026-000063',
      proposalTitle: 'Comprehensive Sensory Therapy Gym',
    };
    const usage = await prisma.followUpEmailLog.groupBy({
      by: ['templateKey'],
      _count: { _all: true },
    });
    const countOf = new Map(usage.map((u) => [u.templateKey, u._count._all]));

    return {
      templates: rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        step: r.step,
        whenToSend: r.whenToSend,
        objective: r.objective,
        angle: r.angle,
        caution: r.caution,
        subject: r.subject,
        body: r.body,
        active: r.active,
        isBuiltIn: r.isBuiltIn,
        updatedAt: r.updatedAt,
        sentCount: countOf.get(r.key) ?? 0,
        preview: renderFollowUp(
          {
            key: r.key,
            name: r.name,
            step: r.step,
            whenToSend: r.whenToSend,
            objective: r.objective,
            angle: r.angle,
            subject: r.subject,
            body: r.body,
          },
          sample,
        ),
      })),
      placeholders: [
        { token: '[First Name]', means: 'The recipient\u2019s first name' },
        { token: '[Customer]', means: 'The customer\u2019s organization name' },
        { token: '[Proposal Number]', means: 'e.g. P-2026-000063' },
        { token: '[Proposal]', means: 'The proposal title' },
        { token: '[Sender]', means: 'Your own first name' },
      ],
    };
  });

  app.post('/admin/follow-up-templates', manage, async (req, reply) => {
    const parsed = TemplateInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid template');
    const d = parsed.data;
    const clash = await prisma.followUpTemplate.findUnique({ where: { key: d.key } });
    if (clash) throw new ValidationError(`A template already uses the key “${d.key}”.`);
    const row = await prisma.followUpTemplate.create({
      data: {
        key: d.key,
        name: d.name,
        step: d.step,
        whenToSend: d.whenToSend,
        objective: d.objective,
        angle: d.angle,
        caution: d.caution ?? null,
        subject: d.subject,
        body: d.body,
        active: d.active ?? true,
        isBuiltIn: false,
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'followUpTemplate.create',
      entity: 'FollowUpTemplate',
      entityId: row.id,
      details: { key: d.key, step: d.step },
    });
    return reply.status(201).send(row);
  });

  app.patch('/admin/follow-up-templates/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.followUpTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const parsed = TemplateInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid template');
    const d = parsed.data;
    // The key is the join to the send history, so it is fixed once a template has been
    // used. Renaming it would orphan every line that records it.
    if (d.key && d.key !== existing.key) {
      const used = await prisma.followUpEmailLog.count({ where: { templateKey: existing.key } });
      if (used) {
        throw new ValidationError(
          `This template has been sent ${used} time${used === 1 ? '' : 's'}, so its key is fixed — the history refers to it. Change the name instead.`,
        );
      }
      const clash = await prisma.followUpTemplate.findUnique({ where: { key: d.key } });
      if (clash) throw new ValidationError(`A template already uses the key “${d.key}”.`);
    }
    const row = await prisma.followUpTemplate.update({
      where: { id },
      data: {
        ...(d.key ? { key: d.key } : {}),
        ...(d.name ? { name: d.name } : {}),
        ...(d.step !== undefined ? { step: d.step } : {}),
        ...(d.whenToSend ? { whenToSend: d.whenToSend } : {}),
        ...(d.objective ? { objective: d.objective } : {}),
        ...(d.angle ? { angle: d.angle } : {}),
        ...(d.caution !== undefined ? { caution: d.caution || null } : {}),
        ...(d.subject ? { subject: d.subject } : {}),
        ...(d.body ? { body: d.body } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'followUpTemplate.update',
      entity: 'FollowUpTemplate',
      entityId: id,
      details: { key: row.key, changed: Object.keys(d) },
    });
    return row;
  });

  /**
   * Retire a template. A built-in is switched off rather than deleted, and so is any
   * template that has been sent — the history names it, and a name that resolves to
   * nothing is a worse record than one that resolves to something retired.
   */
  app.delete('/admin/follow-up-templates/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.followUpTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const used = await prisma.followUpEmailLog.count({ where: { templateKey: existing.key } });
    if (existing.isBuiltIn || used) {
      await prisma.followUpTemplate.update({ where: { id }, data: { active: false } });
      await recordAudit({
        actorId: req.user!.sub,
        action: 'followUpTemplate.retire',
        entity: 'FollowUpTemplate',
        entityId: id,
        details: { key: existing.key, used },
      });
      return { retired: true, deleted: false };
    }
    await prisma.followUpTemplate.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'followUpTemplate.delete',
      entity: 'FollowUpTemplate',
      entityId: id,
      details: { key: existing.key },
    });
    return reply.status(204).send();
  });

  /** Put a built-in back the way it shipped, for when an edit has gone wrong. */
  app.post('/admin/follow-up-templates/:id/reset', manage, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.followUpTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const seed = defaultTemplateByKey(existing.key);
    if (!seed)
      throw new ValidationError(
        'This template was not one of the originals, so there is nothing to restore.',
      );
    const row = await prisma.followUpTemplate.update({
      where: { id },
      data: {
        name: seed.name,
        step: seed.step,
        whenToSend: seed.whenToSend,
        objective: seed.objective,
        angle: seed.angle,
        caution: seed.caution ?? null,
        subject: seed.subject,
        body: seed.body,
        active: true,
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'followUpTemplate.reset',
      entity: 'FollowUpTemplate',
      entityId: id,
      details: { key: existing.key },
    });
    return row;
  });
}

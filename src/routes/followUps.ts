import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  FOLLOW_UP_TEMPLATES,
  firstNameOf,
  renderFollowUp,
  templateByKey,
  type FollowUpContext,
} from '../email/followUpTemplates.js';

/**
 * Proposal follow-up emails.
 *
 * The CRM writes the email and hands it to the rep's clipboard; the rep pastes it
 * into Outlook and sends it from their own mailbox. That is the same choice the
 * existing customer-email composer makes, for the same reason — a follow-up asking
 * "what are your initial thoughts?" has to arrive as a person's mail and the reply
 * has to land in that person's inbox, not in a transactional stream.
 *
 * The consequence is that the app cannot observe the send. A log row is therefore
 * the rep's assertion that they sent it, and the field is named `copiedAt` rather
 * than `sentAt` so nobody later mistakes it for a delivery receipt. It is still the
 * record that answers the question the rep actually has: which of the ten has this
 * customer already had?
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

export function registerFollowUpRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CRM_READ) };
  const write = { preHandler: requirePermission(Permission.CRM_WRITE) };

  /**
   * Every template, rendered for this customer, with its send history attached.
   *
   * Rendering server-side keeps one copy of the copy. The browser gets finished HTML
   * and finished plain text, so the clipboard write is a two-line operation and the
   * wording cannot drift between the preview and what the customer receives.
   */
  app.get('/crm/organizations/:organizationId/follow-ups', read, async (req) => {
    const { organizationId } = req.params as { organizationId: string };
    const q = req.query as { proposalId?: string; contactId?: string };

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

    const proposal = q.proposalId
      ? await prisma.proposal.findUnique({
          where: { id: q.proposalId },
          select: { id: true, number: true, title: true },
        })
      : null;

    const sender = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });

    const contact =
      (q.contactId ? org.contacts.find((c) => c.id === q.contactId) : undefined) ?? org.contacts[0];

    // The greeting uses the contact's own first-name field rather than splitting a
    // display name — "Mary Beth" and "de la Cruz" both survive that way.
    const ctx: FollowUpContext = {
      firstName: contact?.firstName?.trim() || 'there',
      senderFirstName: firstNameOf(sender?.name) === 'there' ? '' : firstNameOf(sender?.name),
      customerName: org.name,
      proposalNumber: proposal?.number,
      proposalTitle: proposal?.title ?? undefined,
    };

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
      // decides — a hard block would be wrong the first time a customer changes
      // contact or a project restarts a year later.
      templates: FOLLOW_UP_TEMPLATES.map((t) => {
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

  /** Record that a template went out. Called after the copy succeeds, not before. */
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
    const template = templateByKey(d.templateKey);
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
   * that it is complete, so deleting is audited.
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
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { documentPdf } from '../integrations/quickbooks/billing.js';
import { refreshInvoice } from '../integrations/quickbooks/receivables.js';
import {
  OutlookNotConnectedError,
  OutlookSendNotGrantedError,
  sendOutlookMail,
  type MailAttachment,
} from '../integrations/microsoft/graph.js';
import { getFile } from '../lib/fileStore.js';
import {
  emailShell,
  expandFigures,
  letterFilename,
  letterPdf,
  longDate,
  renderTemplate,
  sanitizeTemplateHtml,
  type MergeValues,
} from '../email/paymentTemplates.js';
import { composeContext, sanitizeEntered } from './receivables.js';
import type { Prisma } from '@prisma/client';

/**
 * The payment request itself: render the letter, gather the attachments, send it
 * from the sender's own Outlook mailbox.
 *
 * This lives under /render/* — and therefore on the renderer function, with 60
 * seconds and 3009 MB (see vercel.json and api/render.ts) — because it launches
 * headless Chromium to print the letter on letterhead. The main API function has
 * thirty seconds and 1 GB, which is not enough for a Chromium cold start plus a
 * QuickBooks PDF fetch plus three Graph calls, and the failure mode when it is not
 * enough is a timeout in the middle of sending a customer a demand for money.
 *
 * The read-only half of this feature — the ledger, the composer's data, the PO —
 * stays on the main function in routes/receivables.ts, where it costs nothing.
 */

const SendInput = z.object({
  /** One or more addresses, comma separated, as typed. */
  to: z.string().trim().min(1).max(600),
  cc: z.string().trim().max(600).nullish(),
  subject: z.string().trim().min(1).max(300),
  /** The body as the sender left it — they may have edited the template. */
  bodyHtml: z.string().trim().min(1).max(60_000),
  emailTemplateKey: z.string().trim().max(60).nullish(),
  /** Attach a letterhead letter, rendered from this template. */
  letterTemplateKey: z.string().trim().max(60).nullish(),
  attachInvoicePdf: z.boolean().optional(),
  /** CustomerPurchaseOrderFile ids to attach. */
  poFileIds: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
  entered: z.record(z.string()).optional(),
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function addressList(raw: string | null | undefined): Array<{ email: string }> {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => {
      if (!EMAIL_RE.test(email))
        throw new ValidationError(`"${email}" is not a valid email address.`);
      return { email };
    });
}

export function registerReceivableRenderRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ACCOUNTING_READ) };
  const write = { preHandler: requirePermission(Permission.ACCOUNTING_WRITE) };
  const manage = { preHandler: requirePermission(Permission.RULES_MANAGE) };

  /**
   * Send the payment request.
   *
   * Order of operations matters and is deliberate:
   *
   *   1. Re-read the balance from QuickBooks. The composer may have been open for
   *      an hour, and chasing a customer who paid this morning is the failure worth
   *      engineering against. A QuickBooks that cannot be reached does not block the
   *      send — the mirror is used and the message says which figure it quoted — but
   *      a balance of zero always does.
   *   2. Build every attachment BEFORE sending. A message that promises an invoice
   *      and arrives without one is worse than one that was never sent, so a failed
   *      attachment fails the whole send with the reason.
   *   3. Send, then record. The row is written either way, because a log that drops
   *      failures overstates how hard a balance has been chased.
   */
  app.post('/render/receivables/:txnId/payment-request/send', write, async (req, reply) => {
    const { txnId } = req.params as { txnId: string };
    const parsed = SendInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
    const d = parsed.data;

    const to = addressList(d.to);
    const cc = addressList(d.cc);
    if (!to.length) throw new ValidationError('Give at least one recipient.');

    // 1. Freshest balance available.
    let staleFigures = false;
    try {
      await refreshInvoice(txnId, { force: false });
    } catch (err) {
      staleFigures = true;
      logger.warn({ err, txnId }, 'payment request: could not refresh from QuickBooks before send');
    }

    const ctx = await composeContext(txnId, req.user!.sub);
    if (ctx.balance <= 0n) {
      throw new ConflictError(
        'This invoice is paid in full as of just now, so nothing was sent. Refresh the list to see the payment.',
      );
    }

    const values: MergeValues = { ...ctx.values, ...sanitizeEntered(d.entered) };

    // 2. Attachments.
    const attachments: MailAttachment[] = [];
    let attachedInvoicePdf = false;
    let attachedLetterPdf = false;
    let letterName: string | null = null;

    if (d.attachInvoicePdf !== false) {
      try {
        const { pdf, filename } = await documentPdf(txnId);
        attachments.push({ filename, contentType: 'application/pdf', bytes: pdf });
        attachedInvoicePdf = true;
      } catch (err) {
        throw new ValidationError(
          `The invoice PDF could not be fetched from QuickBooks to attach: ${err instanceof Error ? err.message : String(err)}. Untick "attach the invoice" to send without it.`,
        );
      }
    }

    if (d.letterTemplateKey) {
      const template = await prisma.paymentTemplate.findUnique({
        where: { key: d.letterTemplateKey },
      });
      if (!template) throw new NotFoundError('That letter template was not found.');
      if (template.kind !== 'LETTER')
        throw new ValidationError('That template is an email, not a letter.');

      const title = renderTemplate(template.subject, values);
      const body = renderTemplate(expandFigures(template.bodyHtml, values), values);
      if (body.missing.length) {
        // Refused rather than sent with holes. A letter reading "your balance of
        // is now due" is not a letter anybody wants to have sent under their name.
        throw new ValidationError(
          `The letter “${template.name}” uses ${body.missing.map((m) => `{{${m}}}`).join(', ')}, which ${body.missing.length === 1 ? 'has' : 'have'} no value for this invoice. Fill ${body.missing.length === 1 ? 'it' : 'them'} in on the send form, or edit the letter.`,
        );
      }

      const pdf = await letterPdf({
        title: title.html,
        bodyHtml: body.html,
        addressee: [values.customer_name ?? '', values.organization_name ?? ''],
        sender: {
          name: values.sender_name ?? '',
          title: values.sender_title ?? '',
          email: values.sender_email ?? '',
          phone: values.sender_phone ?? '',
        },
        dateLine: longDate(new Date()),
      });
      attachments.push({
        filename: letterFilename(template.name, ctx.txn.qboDocNumber),
        contentType: 'application/pdf',
        bytes: pdf,
      });
      attachedLetterPdf = true;
      letterName = template.name;
    }

    const poFileIds = d.poFileIds ?? [];
    if (poFileIds.length) {
      if (!ctx.order) {
        throw new ConflictError(
          'This invoice has no accepted order, so it has no purchase-order documents.',
        );
      }
      const files = await prisma.customerPurchaseOrderFile.findMany({
        where: { id: { in: poFileIds }, orderId: ctx.order.id },
      });
      if (files.length !== poFileIds.length) {
        throw new NotFoundError('One of the purchase-order documents was not found on this order.');
      }
      for (const f of files) {
        attachments.push({
          filename: f.filename,
          contentType: f.contentType,
          bytes: await getFile(f.url),
        });
      }
    }

    // 3. Send. The body is sanitised on the way out: it has been through a browser
    // where somebody may have pasted anything into it, and it is about to be sent
    // under this company's name.
    const bodyHtml = emailShell(sanitizeTemplateHtml(d.bodyHtml));
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    const senderName = user?.name ?? user?.email ?? 'Unknown';

    let graphMessageId: string | null = null;
    let mailbox = '';
    let error: string | null = null;
    try {
      const sent = await sendOutlookMail({
        userId: req.user!.sub,
        to,
        cc,
        subject: d.subject,
        html: bodyHtml,
        attachments,
      });
      graphMessageId = sent.id;
      mailbox = sent.mailbox;
    } catch (err) {
      error = err instanceof Error ? err.message : 'The send failed.';
    }

    const row = await prisma.paymentRequestEmail.create({
      data: {
        qboTransactionId: txnId,
        organizationId: ctx.proposal?.organizationId ?? null,
        orderId: ctx.order?.id ?? null,
        mailbox: mailbox || (ctx.sender?.email ?? ''),
        toEmail: to.map((t) => t.email).join(', '),
        ccEmail: cc.length ? cc.map((c) => c.email).join(', ') : null,
        subject: d.subject,
        bodyHtml,
        emailTemplateKey: d.emailTemplateKey ?? null,
        letterTemplateKey: d.letterTemplateKey ?? null,
        letterTemplateName: letterName,
        attachedInvoicePdf,
        attachedLetterPdf,
        attachedPoFileIds: poFileIds,
        balanceMinor: ctx.balance,
        currency: ctx.txn.currency,
        mergeValues: values as unknown as Prisma.InputJsonValue,
        graphMessageId,
        status: error ? 'failed' : 'sent',
        error,
        sentById: req.user!.sub,
        sentByName: senderName,
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: error ? 'receivables.request.send_failed' : 'receivables.request.sent',
      entity: 'QboTransaction',
      entityId: txnId,
      details: {
        to: to.map((t) => t.email),
        docNumber: ctx.txn.qboDocNumber,
        balanceMinor: ctx.balance.toString(),
        letter: letterName,
        attachments: attachments.map((a) => a.filename),
        error,
      },
    });

    // The customer's own timeline, so the account history reads as one thing
    // rather than making somebody check two screens.
    if (!error && ctx.proposal?.organizationId) {
      await prisma.customerNote
        .create({
          data: {
            organizationId: ctx.proposal.organizationId,
            proposalId: ctx.txn.proposalId,
            body: `Payment request for ${ctx.txn.qboDocNumber ?? 'invoice'} (${values.balance_due ?? ''} outstanding) emailed to ${to
              .map((t) => t.email)
              .join(', ')}${letterName ? ` with the “${letterName}” letter attached` : ''}.`,
            authorId: req.user!.sub,
            authorName: senderName,
          },
        })
        .catch(() => undefined);
    }

    if (error) {
      if (
        error.includes('connected before this app could send') ||
        error.includes('not connected')
      ) {
        return reply
          .status(409)
          .send({ error: 'OUTLOOK_NOT_READY', message: error, logId: row.id });
      }
      return reply.status(502).send({ error: 'SEND_FAILED', message: error, logId: row.id });
    }

    return {
      sent: true,
      id: row.id,
      mailbox,
      to: to.map((t) => t.email),
      attachments: attachments.map((a) => ({ filename: a.filename, bytes: a.bytes.length })),
      balanceQuotedMinor: ctx.balance.toString(),
      staleFigures,
    };
  });

  /**
   * The letter as a PDF, rendered against a real invoice, without sending it.
   *
   * A letter that goes out on letterhead over somebody's name should be looked at
   * first. Same renderer, same letterhead, same merge values as the send — the only
   * difference is that nothing leaves the building.
   */
  app.post('/render/receivables/:txnId/letter-preview.pdf', read, async (req, reply) => {
    const { txnId } = req.params as { txnId: string };
    const b = (req.body ?? {}) as { letterTemplateKey?: string; entered?: Record<string, string> };
    if (!b.letterTemplateKey) throw new ValidationError('Choose a letter to preview.');

    const template = await prisma.paymentTemplate.findUnique({
      where: { key: b.letterTemplateKey },
    });
    if (!template) throw new NotFoundError('That letter template was not found.');
    if (template.kind !== 'LETTER')
      throw new ValidationError('That template is an email, not a letter.');

    const ctx = await composeContext(txnId, req.user!.sub);
    const values: MergeValues = { ...ctx.values, ...sanitizeEntered(b.entered) };
    const title = renderTemplate(template.subject, values);
    const body = renderTemplate(expandFigures(template.bodyHtml, values), values);

    const pdf = await letterPdf({
      title: title.html,
      bodyHtml: body.html,
      addressee: [values.customer_name ?? '', values.organization_name ?? ''],
      sender: {
        name: values.sender_name ?? '',
        title: values.sender_title ?? '',
        email: values.sender_email ?? '',
        phone: values.sender_phone ?? '',
      },
      dateLine: longDate(new Date()),
    });
    return reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `inline; filename="${letterFilename(template.name, ctx.txn.qboDocNumber)}"`,
      )
      .header('X-Missing-Fields', body.missing.join(',') || 'none')
      .send(pdf);
  });

  /**
   * A letter previewed against sample figures, for the admin screen.
   *
   * Sample rather than live, because somebody editing the wording of a letter
   * should not have to pick a customer to owe money first.
   */
  app.post('/render/admin/payment-templates/:id/preview.pdf', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const template = await prisma.paymentTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundError('Template not found');
    if (template.kind !== 'LETTER')
      throw new ValidationError('Only a letter prints on letterhead.');

    const sender = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true, title: true, phone: true },
    });
    const values: MergeValues = {
      customer_first_name: 'Emily',
      customer_name: 'Emily Hartman',
      organization_name: 'Uniquely Yours Specialized Care',
      invoice_number: 'P-2026-000063',
      invoice_date: 'March 4, 2026',
      invoice_amount: '$212,850.00',
      invoice_link: 'https://connect.intuit.com/pay/example',
      balance_due: '$106,425.00',
      amount_paid: '$106,425.00',
      due_date: 'April 3, 2026',
      days_past_due: '12',
      po_number: 'PO-88431',
      order_number: 'ACC-UY-20260304-001',
      proposal_number: 'P-2026-000063',
      sender_name: sender?.name ?? sender?.email ?? '',
      sender_title: sender?.title ?? '',
      sender_email: sender?.email ?? '',
      sender_phone: sender?.phone ?? '',
      today: longDate(new Date()),
      tentative_ship_date: 'May 18, 2026',
      payment_deadline: 'April 30, 2026',
      final_payment_deadline: 'May 11, 2026',
    };

    const title = renderTemplate(template.subject, values);
    const body = renderTemplate(expandFigures(template.bodyHtml, values), values);
    const pdf = await letterPdf({
      title: title.html,
      bodyHtml: body.html,
      addressee: [values.customer_name ?? '', values.organization_name ?? ''],
      sender: {
        name: values.sender_name ?? '',
        title: values.sender_title ?? '',
        email: values.sender_email ?? '',
        phone: values.sender_phone ?? '',
      },
      dateLine: longDate(new Date()),
    });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${letterFilename(template.name, null)}"`)
      .send(pdf);
  });
}

/** Re-exported so the error classes stay reachable from one import site. */
export { OutlookNotConnectedError, OutlookSendNotGrantedError };

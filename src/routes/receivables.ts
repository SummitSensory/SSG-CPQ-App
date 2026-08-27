import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { qboEnvironment } from '../config/env.js';
import {
  ledger,
  refreshInvoice,
  refreshOpenInvoices,
  daysPastDue,
} from '../integrations/quickbooks/receivables.js';
import { pushPoToInvoice, setOrderPoNumber } from '../integrations/quickbooks/poSync.js';
import { outlookStatusFor } from '../integrations/microsoft/graph.js';
import { dealItemForVersion, readDealReferences } from '../integrations/monday/dealReferences.js';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  deleteFile,
  getFile,
  isFileStoreConfigured,
  purchaseOrderPath,
  putFile,
  safeSegment,
} from '../lib/fileStore.js';
import {
  DEFAULT_EMAIL_TEMPLATE,
  DEFAULT_LETTER_TEMPLATES,
  ENTERED_FIELDS,
  MERGE_FIELDS,
  expandFigures,
  longDate,
  money,
  renderTemplate,
  sanitizeTemplateHtml,
  tokensIn,
  type MergeValues,
} from '../email/paymentTemplates.js';
import type { QboEnvironment } from '@prisma/client';

/**
 * Accounts receivable, the customer's purchase order, and the payment-request
 * email.
 *
 * Everything here is either a read of the QuickBooks mirror or a write to OUR
 * records. The two calls that leave the building — pushing the PO onto an invoice
 * and sending the email — are the only exceptions, and the send lives on the
 * renderer function instead (see routes/receivablesRender.ts) because it renders a
 * PDF and the 30-second main function cannot.
 *
 * Permissions: reading is `accounting:read`, which Accounting and Executive hold;
 * every write is `accounting:write`, which is Accounting and System Admin. That is
 * deliberately narrower than the Orders screen — entering a PO here also rewrites a
 * live QuickBooks document, and sending from here puts a demand for money in front
 * of a customer under somebody's own name. To let another role do it, add
 * ACCOUNTING_WRITE to that role in authz/permissions.ts.
 */

const PoNumberInput = z.object({
  poNumber: z.string().trim().max(80).nullable(),
});

const UploadInput = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  /** The file, base64. The app's body limit is 8 MB, which fits the 3 MB cap. */
  base64: z.string().min(1),
  poNumber: z.string().trim().max(80).nullish(),
});

const TemplateInput = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, numbers and hyphens.'),
  kind: z.enum(['EMAIL', 'LETTER']),
  name: z.string().trim().min(1).max(120),
  stage: z.number().int().min(1).max(99).optional(),
  whenToUse: z.string().trim().max(300).nullish(),
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().trim().min(1).max(60_000),
  active: z.boolean().optional(),
});

/** Sample values, so a template can be previewed without opening a real invoice. */
const SAMPLE_VALUES: MergeValues = {
  customer_first_name: 'Emily',
  customer_name: 'Emily Hartman',
  organization_name: 'Uniquely Yours Specialized Care',
  invoice_number: 'P-2026-000063',
  invoice_date: 'March 4, 2026',
  invoice_amount: '$212,850.00',
  invoice_link: 'https://connect.intuit.com/pay/example',
  customer_title: 'VP of Sales',
  customer_address: '9876 NewTech Way',
  customer_city_state_zip: 'San Jose, CA 95113',
  payments_credits: '$18,450.00',
  customer_service_email: 'Sales@SummitSensory.com',
  customer_service_phone: '(720) 457-5500',
  balance_due: '$106,425.00',
  amount_paid: '$106,425.00',
  due_date: 'April 3, 2026',
  days_past_due: '12',
  po_number: 'PO-88431',
  order_number: 'ACC-UY-20260304-001',
  proposal_number: 'P-2026-000063',
  sender_name: 'Bryan Kelley',
  sender_title: 'Owner',
  sender_email: 'bryan@summitsensory.com',
  sender_phone: '(555) 123-4567',
  today: longDate(new Date()),
  tentative_ship_date: 'May 18, 2026',
  payment_deadline: 'April 30, 2026',
  final_payment_deadline: 'May 11, 2026',
};

/**
 * Read the templates, seeding the built-in email on first read.
 *
 * The seed runs on first read rather than in a migration because a migration
 * cannot import the copy, and keeping the wording in two places is how it drifts.
 * `createMany` with `skipDuplicates` makes a concurrent first request harmless.
 *
 * The built-in letters are seeded the same way but counted separately, so adding a
 * letter to DEFAULT_LETTER_TEMPLATES seeds it on the next read without disturbing
 * an email somebody has already edited. Only Summit's own letter copy belongs
 * there: a letter goes out over a person's signature, so none of it is invented
 * here. Anything else is typed in under Administration → Payment requests.
 */
async function loadTemplates(includeInactive = false) {
  const count = await prisma.paymentTemplate.count({ where: { kind: 'EMAIL' } });
  if (count === 0) {
    await prisma.paymentTemplate.createMany({
      data: [
        {
          key: DEFAULT_EMAIL_TEMPLATE.key,
          kind: 'EMAIL',
          name: DEFAULT_EMAIL_TEMPLATE.name,
          stage: DEFAULT_EMAIL_TEMPLATE.stage,
          whenToUse: DEFAULT_EMAIL_TEMPLATE.whenToUse,
          subject: DEFAULT_EMAIL_TEMPLATE.subject,
          bodyHtml: DEFAULT_EMAIL_TEMPLATE.bodyHtml,
          isBuiltIn: true,
        },
      ],
      skipDuplicates: true,
    });
  }
  const letterCount = await prisma.paymentTemplate.count({ where: { kind: 'LETTER' } });
  if (letterCount === 0) {
    await prisma.paymentTemplate.createMany({
      data: DEFAULT_LETTER_TEMPLATES.map((t) => ({
        key: t.key,
        kind: 'LETTER' as const,
        name: t.name,
        stage: t.stage,
        whenToUse: t.whenToUse,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        isBuiltIn: true,
      })),
      skipDuplicates: true,
    });
  }
  return prisma.paymentTemplate.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ kind: 'asc' }, { stage: 'asc' }, { name: 'asc' }],
  });
}

/**
 * Everything one invoice needs to compose a message: the figures, who it can be
 * addressed to, and the merge values already resolved.
 *
 * Exported because the send route on the renderer function resolves the SAME
 * values again at send time rather than trusting what the browser had on screen —
 * a composer left open over lunch is quoting a balance from before lunch.
 */
/**
 * Where a customer is told to call about an invoice.
 *
 * Constants rather than merge fields the sender fills in: this is one company with
 * one accounts-receivable line, and a letter that named a different number each
 * time it was sent would be a letter nobody could be held to. Edited here.
 */
const CUSTOMER_SERVICE = {
  email: 'Sales@SummitSensory.com',
  phone: '(720) 457-5500',
};

export async function composeContext(txnId: string, userId: string) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Invoice not found');
  if (txn.type === 'ESTIMATE') throw new ValidationError('An estimate has no balance to chase.');
  if (txn.status !== 'CREATED' || !txn.qboId) {
    throw new ConflictError('This invoice has not been created in QuickBooks yet.');
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id: txn.proposalId },
    select: { id: true, number: true, organizationId: true },
  });
  // Proposal holds organizationId, not an `organization` relation, so the customer
  // and its contacts are their own lookup.
  const org = proposal?.organizationId
    ? await prisma.organization.findUnique({
        where: { id: proposal.organizationId },
        select: {
          id: true,
          name: true,
          // The address the letter is addressed to. BILLING first: a payment letter
          // belongs with accounts payable, which is rarely the loading dock.
          addresses: {
            orderBy: { type: 'asc' },
            select: {
              type: true,
              line1: true,
              line2: true,
              city: true,
              region: true,
              postalCode: true,
            },
          },
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
      })
    : null;
  const order = await prisma.acceptedOrder.findUnique({
    where: { proposalVersionId: txn.proposalVersionId },
    select: {
      id: true,
      number: true,
      customerApproval: { select: { poNumber: true, approverName: true, approverEmail: true } },
    },
  });
  const sender = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true, title: true, phone: true, emailSignatureHtml: true },
  });

  const contacts = org?.contacts ?? [];
  // The address QuickBooks itself billed wins as the default: it is where the
  // invoice went, so it is where a question about the invoice belongs. Falling back
  // to the decision-maker, then to whoever signed.
  const preferred =
    contacts.find(
      (c) => c.email && txn.sentToEmail && c.email.toLowerCase() === txn.sentToEmail.toLowerCase(),
    ) ??
    contacts[0] ??
    null;
  const defaultEmail =
    txn.sentToEmail ?? preferred?.email ?? order?.customerApproval?.approverEmail ?? '';

  // The billing address, then whatever address the customer has.
  const addresses = org?.addresses ?? [];
  const postal = addresses.find((a) => a.type === 'BILLING') ?? addresses[0] ?? null;
  const street = [postal?.line1, postal?.line2].filter((l) => String(l ?? '').trim()).join(', ');
  const cityLine = postal
    ? [[postal.city, postal.region].filter(Boolean).join(', '), postal.postalCode]
        .filter((p) => String(p ?? '').trim())
        .join(' ')
        .trim()
    : '';

  // The payment link, board first. Best effort throughout: monday being unreachable
  // must not stop a letter going out, so the QuickBooks link stands behind it.
  let invoiceLink = txn.qboInvoiceLink ?? '';
  try {
    const item = await dealItemForVersion(txn.proposalVersionId);
    if (item) {
      const board = await readDealReferences(item);
      if (board.invoiceLink) invoiceLink = board.invoiceLink;
    }
  } catch {
    // Logged inside readDealReferences; the fallback is already in place.
  }

  const balance = txn.balanceMinor ?? txn.amountMinor;
  const initialTotal = txn.initialTotalMinor ?? txn.qboTotalMinor ?? txn.amountMinor;
  const overdue = daysPastDue(txn.dueDate, balance);

  const values: MergeValues = {
    customer_first_name:
      preferred?.firstName?.trim() ||
      (order?.customerApproval?.approverName ?? '').trim().split(/\s+/)[0] ||
      '',
    customer_name:
      [preferred?.firstName, preferred?.lastName].filter(Boolean).join(' ').trim() ||
      (order?.customerApproval?.approverName ?? ''),
    customer_title: preferred?.title ?? '',
    organization_name: org?.name ?? '',
    customer_address: street,
    customer_city_state_zip: cityLine,
    invoice_number: txn.qboDocNumber ?? '',
    invoice_date: longDate(txn.invoiceDate),
    invoice_amount: money(initialTotal, txn.currency),
    invoice_link: invoiceLink,
    balance_due: money(balance, txn.currency),
    amount_paid: money(txn.paidMinor ?? 0n, txn.currency),
    payments_credits: money(txn.paidMinor ?? 0n, txn.currency),
    due_date: longDate(txn.dueDate),
    days_past_due: String(overdue),
    po_number: order?.customerApproval?.poNumber ?? '',
    order_number: order?.number ?? '',
    proposal_number: proposal?.number ?? '',
    sender_name: sender?.name ?? sender?.email ?? '',
    sender_title: sender?.title ?? '',
    sender_email: sender?.email ?? '',
    sender_phone: sender?.phone ?? '',
    customer_service_email: CUSTOMER_SERVICE.email,
    customer_service_phone: CUSTOMER_SERVICE.phone,
    today: longDate(new Date()),
  };

  return {
    txn,
    proposal,
    org,
    order,
    sender,
    contacts,
    defaultEmail,
    values,
    balance,
    initialTotal,
    overdue,
  };
}

export function registerReceivableRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.ACCOUNTING_READ) };
  const write = { preHandler: requirePermission(Permission.ACCOUNTING_WRITE) };
  // Editing the templates changes what every sender sends, which is an
  // administrative act — the same rule the follow-up templates use.
  const manage = { preHandler: requirePermission(Permission.RULES_MANAGE) };

  /* ------------------------------------------------------------------ ledger */

  app.get('/receivables', read, async (req) => {
    const q = req.query as { all?: string };
    const all = q.all === '1' || q.all === 'true';
    return ledger({ openOnly: !all });
  });

  /**
   * Re-read the open invoices from QuickBooks.
   *
   * Capped, and the cap is the point: the main function has thirty seconds and
   * each invoice is at least one Intuit round trip. The nightly sweep is what keeps
   * the whole ledger current (see routes/cronReceivables.ts); this is for the
   * person who just took a payment and wants to see it.
   */
  app.post('/receivables/refresh', write, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 25) || 25, 1), 40);
    const out = await refreshOpenInvoices(limit);
    return {
      ...out,
      limit,
      note:
        out.checked === limit
          ? 'More invoices remain; run it again or wait for the nightly sweep.'
          : null,
    };
  });

  app.post('/receivables/:txnId/refresh', write, async (req, reply) => {
    const { txnId } = req.params as { txnId: string };
    try {
      const txn = await refreshInvoice(txnId, { force: true });
      return {
        refreshed: true,
        balanceMinor: (txn.balanceMinor ?? 0n).toString(),
        paidMinor: (txn.paidMinor ?? 0n).toString(),
        status: txn.qboStatus,
        invoiceLink: txn.qboInvoiceLink,
      };
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      req.log.error({ err, txnId }, 'receivables: refresh failed');
      return reply.status(502).send({
        error: 'QBO_SYNC_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /* ------------------------------------------------------- the customer's PO */

  /**
   * Record the customer's purchase-order number on the order.
   *
   * Editable at any time, which is the whole point: the PO is usually raised after
   * the order is placed. It writes CustomerApproval.poNumber — the field the
   * QuickBooks push and the order paperwork already read — and flags any live
   * invoice that no longer agrees, rather than pushing silently. Rewriting a
   * customer's live invoice is a deliberate act.
   */
  app.put('/orders/:orderId/po-number', write, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const parsed = PoNumberInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid purchase-order number');
    }
    return setOrderPoNumber(orderId, parsed.data.poNumber, req.user!.sub);
  });

  /** Write the order's PO onto its QuickBooks invoice. */
  app.post('/receivables/:txnId/push-po', write, async (req, reply) => {
    const { txnId } = req.params as { txnId: string };
    try {
      return await pushPoToInvoice(txnId, req.user!.sub);
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      req.log.error({ err, txnId }, 'receivables: PO push failed');
      return reply.status(502).send({
        error: 'QBO_PO_PUSH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /* ------------------------------------------------------- PO documents */

  app.get('/orders/:orderId/purchase-orders', read, async (req) => {
    const { orderId } = req.params as { orderId: string };
    const rows = await prisma.customerPurchaseOrderFile.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      storageConfigured: isFileStoreConfigured(),
      maxBytes: MAX_UPLOAD_BYTES,
      accept: Object.keys(ALLOWED_UPLOAD_TYPES),
      files: rows.map((f) => ({
        id: f.id,
        filename: f.filename,
        contentType: f.contentType,
        byteSize: f.byteSize,
        poNumber: f.poNumber,
        uploadedBy: f.uploadedByName,
        uploadedAt: f.createdAt.toISOString(),
      })),
    };
  });

  /**
   * Upload the customer's purchase order.
   *
   * Base64 in a JSON body rather than multipart: the app registers no multipart
   * parser, and adding one for a single 3 MB upload is a dependency and a new class
   * of parsing bug for no gain. The 8 MB body limit accommodates base64's third.
   *
   * The content type is checked against an allow-list rather than trusted, and the
   * row is only written after the bytes are safely stored — an upload that failed
   * must not appear in the list as though it worked.
   */
  app.post('/orders/:orderId/purchase-orders', write, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const parsed = UploadInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid upload');
    }
    const d = parsed.data;

    const order = await prisma.acceptedOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        organizationId: true,
        customerApproval: { select: { poNumber: true } },
      },
    });
    if (!order) throw new NotFoundError('Order not found');

    const contentType = d.contentType.split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_UPLOAD_TYPES[contentType]) {
      throw new ValidationError(
        `${contentType} is not a file type this accepts. Use a PDF, an image, a Word document or a spreadsheet.`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(d.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch {
      throw new ValidationError('That file could not be read.');
    }
    if (!bytes.length) throw new ValidationError('That file is empty.');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is 3 MB, which is also the largest attachment Outlook takes through this route.`,
      );
    }
    if (!isFileStoreConfigured()) {
      throw new ConflictError(
        'File storage is not configured on this deployment, so the purchase order cannot be kept. An administrator needs to set BLOB_READ_WRITE_TOKEN.',
      );
    }

    const id = `po_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const stored = await putFile(
      purchaseOrderPath({ orderNumber: order.number, fileId: id, filename: d.filename }),
      bytes,
      contentType,
    );

    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, email: true },
    });
    const row = await prisma.customerPurchaseOrderFile.create({
      data: {
        id,
        orderId: order.id,
        organizationId: order.organizationId,
        filename: safeSegment(d.filename, 'purchase-order'),
        contentType,
        byteSize: stored.bytes,
        url: stored.url,
        pathname: stored.pathname,
        poNumber: (d.poNumber ?? order.customerApproval?.poNumber ?? null) || null,
        uploadedById: req.user!.sub,
        uploadedByName: user?.name ?? user?.email ?? 'Unknown',
      },
    });

    await recordAudit({
      actorId: req.user!.sub,
      action: 'order.purchaseOrder.uploaded',
      entity: 'AcceptedOrder',
      entityId: order.id,
      details: { filename: row.filename, bytes: row.byteSize, poNumber: row.poNumber },
    });

    return reply.status(201).send({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      byteSize: row.byteSize,
      poNumber: row.poNumber,
      uploadedBy: row.uploadedByName,
      uploadedAt: row.createdAt.toISOString(),
    });
  });

  /**
   * Serve a stored purchase order.
   *
   * Proxied rather than redirected to the blob URL for two reasons: the app's
   * Content-Security-Policy allows images and frames from 'self' only, so a
   * blob-hosted document would refuse to display in the CRM; and a public URL to a
   * customer's commercial document is not something to hand to a browser, where it
   * survives in history and referrer headers.
   */
  app.get('/orders/:orderId/purchase-orders/:fileId/download', read, async (req, reply) => {
    const { orderId, fileId } = req.params as { orderId: string; fileId: string };
    const row = await prisma.customerPurchaseOrderFile.findUnique({ where: { id: fileId } });
    if (!row || row.orderId !== orderId)
      throw new NotFoundError('That purchase order was not found');
    const bytes = await getFile(row.url);
    return reply
      .header('Content-Type', row.contentType)
      .header('Content-Disposition', `inline; filename="${row.filename}"`)
      .header('Cache-Control', 'private, max-age=60')
      .send(bytes);
  });

  app.delete('/orders/:orderId/purchase-orders/:fileId', write, async (req, reply) => {
    const { orderId, fileId } = req.params as { orderId: string; fileId: string };
    const row = await prisma.customerPurchaseOrderFile.findUnique({ where: { id: fileId } });
    if (!row || row.orderId !== orderId)
      throw new NotFoundError('That purchase order was not found');
    await prisma.customerPurchaseOrderFile.delete({ where: { id: fileId } });
    // Row first, blob second: an orphaned blob is housekeeping, an orphaned row is
    // a download that 500s.
    await deleteFile(row.url);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'order.purchaseOrder.deleted',
      entity: 'AcceptedOrder',
      entityId: orderId,
      details: { filename: row.filename, uploadedAt: row.createdAt.toISOString() },
    });
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- composer */

  /**
   * Everything the composer needs for one invoice, in one request.
   *
   * Includes the reasons it cannot be sent, as words. A disabled button with no
   * explanation is the failure mode this codebase keeps having to fix.
   */
  app.get('/receivables/:txnId/compose', read, async (req) => {
    const { txnId } = req.params as { txnId: string };
    const ctx = await composeContext(txnId, req.user!.sub);
    const templates = await loadTemplates();
    const outlook = await outlookStatusFor(req.user!.sub);

    const poFiles = ctx.order
      ? await prisma.customerPurchaseOrderFile.findMany({
          where: { orderId: ctx.order.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, filename: true, byteSize: true, poNumber: true, createdAt: true },
        })
      : [];

    const history = await prisma.paymentRequestEmail.findMany({
      where: { qboTransactionId: txnId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        toEmail: true,
        ccEmail: true,
        subject: true,
        letterTemplateName: true,
        attachedInvoicePdf: true,
        attachedLetterPdf: true,
        attachedPoFileIds: true,
        balanceMinor: true,
        status: true,
        error: true,
        sentByName: true,
        mailbox: true,
        createdAt: true,
      },
    });

    const blockers: string[] = [];
    if (ctx.balance <= 0n) {
      blockers.push('This invoice is paid in full — there is nothing to ask them for.');
    }
    if (!outlook.configured) {
      blockers.push(
        'Outlook is not configured on this deployment. An administrator needs to add the Microsoft Graph settings.',
      );
    } else if (!outlook.connected) {
      blockers.push(
        'Your Outlook mailbox is not connected. Connect it from your profile — the email is sent from your own account, so there is no way to do it for you.',
      );
    } else if (!outlook.canSend) {
      blockers.push(
        'Your Outlook mailbox was connected before this app could send on your behalf. Connect Outlook again — one click, and everything else stays as it is.',
      );
    }
    if (!ctx.defaultEmail) {
      blockers.push(
        'There is no email address on file for this customer. Add a contact with an email address first.',
      );
    }

    return {
      invoice: {
        transactionId: ctx.txn.id,
        type: ctx.txn.type,
        docNumber: ctx.txn.qboDocNumber,
        currency: ctx.txn.currency,
        initialTotalMinor: ctx.initialTotal.toString(),
        currentTotalMinor: (ctx.txn.qboTotalMinor ?? ctx.txn.amountMinor).toString(),
        paidMinor: (ctx.txn.paidMinor ?? 0n).toString(),
        balanceMinor: ctx.balance.toString(),
        status: ctx.txn.qboStatus,
        invoiceDate: ctx.txn.invoiceDate?.toISOString().slice(0, 10) ?? null,
        dueDate: ctx.txn.dueDate?.toISOString().slice(0, 10) ?? null,
        daysPastDue: ctx.overdue,
        invoiceLink: ctx.txn.qboInvoiceLink,
        lastSyncedAt: ctx.txn.qboLastSyncedAt?.toISOString() ?? null,
      },
      customer: ctx.org ? { id: ctx.org.id, name: ctx.org.name } : null,
      order: ctx.order ? { id: ctx.order.id, number: ctx.order.number } : null,
      poNumber: ctx.order?.customerApproval?.poNumber ?? null,
      poNeedsPush: ctx.txn.poNeedsPush,
      poPushedValue: ctx.txn.poPushedValue,
      poPushedAt: ctx.txn.poPushedAt?.toISOString() ?? null,
      contacts: ctx.contacts.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' '),
        email: c.email,
        title: c.title,
        isDecisionMaker: c.isDecisionMaker,
      })),
      defaultToEmail: ctx.defaultEmail,
      sender: {
        name: ctx.sender?.name ?? '',
        email: ctx.sender?.email ?? '',
        mailbox: outlook.mailbox,
        hasSignature: Boolean((ctx.sender?.emailSignatureHtml ?? '').trim()),
      },
      outlook,
      values: ctx.values,
      enteredFields: ENTERED_FIELDS,
      mergeFields: MERGE_FIELDS,
      emailTemplates: templates
        .filter((t) => t.kind === 'EMAIL')
        .map((t) => ({
          key: t.key,
          name: t.name,
          stage: t.stage,
          whenToUse: t.whenToUse,
          subject: t.subject,
          bodyHtml: t.bodyHtml,
        })),
      letterTemplates: templates
        .filter((t) => t.kind === 'LETTER')
        .map((t) => ({
          key: t.key,
          name: t.name,
          stage: t.stage,
          whenToUse: t.whenToUse,
          subject: t.subject,
        })),
      poFiles: poFiles.map((f) => ({
        id: f.id,
        filename: f.filename,
        byteSize: f.byteSize,
        poNumber: f.poNumber,
        uploadedAt: f.createdAt.toISOString(),
      })),
      history: history.map((h) => ({
        id: h.id,
        toEmail: h.toEmail,
        ccEmail: h.ccEmail,
        subject: h.subject,
        letter: h.letterTemplateName,
        attachedInvoicePdf: h.attachedInvoicePdf,
        attachedLetterPdf: h.attachedLetterPdf,
        attachedPoCount: h.attachedPoFileIds.length,
        balanceMinor: h.balanceMinor.toString(),
        status: h.status,
        error: h.error,
        by: h.sentByName,
        mailbox: h.mailbox,
        at: h.createdAt.toISOString(),
      })),
      blockers,
    };
  });

  /**
   * Render one email template against this invoice, without sending anything.
   *
   * Server-side so the composer's preview is the same string the send will use —
   * a browser that re-implemented the substitution would eventually disagree with
   * it, and the first anyone would know is a customer receiving the disagreement.
   */
  app.post('/receivables/:txnId/preview', read, async (req) => {
    const { txnId } = req.params as { txnId: string };
    const b = (req.body ?? {}) as {
      emailTemplateKey?: string;
      entered?: Record<string, string>;
    };
    const ctx = await composeContext(txnId, req.user!.sub);
    const values: MergeValues = { ...ctx.values, ...sanitizeEntered(b.entered) };

    const template = b.emailTemplateKey
      ? await prisma.paymentTemplate.findUnique({ where: { key: b.emailTemplateKey } })
      : ((await loadTemplates()).find((t) => t.kind === 'EMAIL') ?? null);
    if (!template) throw new NotFoundError('Email template not found');
    if (template.kind !== 'EMAIL')
      throw new ValidationError('That template is a letter, not an email.');

    const subject = renderTemplate(template.subject, values);
    const body = renderTemplate(expandFigures(template.bodyHtml, values), values);
    return {
      templateKey: template.key,
      subject: subject.html,
      bodyHtml: body.html,
      missing: [...new Set([...subject.missing, ...body.missing])],
      unknown: [...new Set([...subject.unknown, ...body.unknown])],
      values,
    };
  });

  /* ------------------------------------------------------- template admin */

  app.get('/admin/payment-templates', read, async () => {
    const rows = await loadTemplates(true);
    const usage = await prisma.paymentRequestEmail.groupBy({
      by: ['letterTemplateKey'],
      _count: { _all: true },
    });
    const countOf = new Map(usage.map((u) => [u.letterTemplateKey ?? '', u._count._all]));

    return {
      mergeFields: MERGE_FIELDS,
      figuresBlock: '{{FIGURES}}',
      templates: rows.map((t) => {
        const subject = renderTemplate(t.subject, SAMPLE_VALUES);
        const body = renderTemplate(expandFigures(t.bodyHtml, SAMPLE_VALUES), SAMPLE_VALUES);
        return {
          id: t.id,
          key: t.key,
          kind: t.kind,
          name: t.name,
          stage: t.stage,
          whenToUse: t.whenToUse,
          subject: t.subject,
          bodyHtml: t.bodyHtml,
          active: t.active,
          isBuiltIn: t.isBuiltIn,
          updatedAt: t.updatedAt.toISOString(),
          usedCount: countOf.get(t.key) ?? 0,
          tokens: tokensIn(`${t.subject} ${t.bodyHtml}`),
          preview: { subject: subject.html, bodyHtml: body.html, unknown: body.unknown },
        };
      }),
    };
  });

  app.post('/admin/payment-templates', manage, async (req, reply) => {
    const parsed = TemplateInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid template');
    const d = parsed.data;
    const clash = await prisma.paymentTemplate.findUnique({ where: { key: d.key } });
    if (clash) throw new ValidationError(`A template already uses the key “${d.key}”.`);

    const row = await prisma.paymentTemplate.create({
      data: {
        key: d.key,
        kind: d.kind,
        name: d.name,
        stage: d.stage ?? 1,
        whenToUse: d.whenToUse ?? null,
        subject: d.subject,
        bodyHtml: sanitizeTemplateHtml(d.bodyHtml),
        active: d.active ?? true,
        isBuiltIn: false,
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paymentTemplate.create',
      entity: 'PaymentTemplate',
      entityId: row.id,
      details: { key: d.key, kind: d.kind },
    });
    return reply.status(201).send(row);
  });

  app.patch('/admin/payment-templates/:id', manage, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.paymentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const parsed = TemplateInput.partial().safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid template');
    const d = parsed.data;

    // The key is the join to the send history, so it is fixed once a template has
    // been used. Renaming it would orphan every line that records it.
    if (d.key && d.key !== existing.key) {
      const used = await prisma.paymentRequestEmail.count({
        where: { OR: [{ letterTemplateKey: existing.key }, { emailTemplateKey: existing.key }] },
      });
      if (used) {
        throw new ValidationError(
          `This template has been used ${used} time${used === 1 ? '' : 's'}, so its key is fixed — the history refers to it. Change the name instead.`,
        );
      }
      const clash = await prisma.paymentTemplate.findUnique({ where: { key: d.key } });
      if (clash) throw new ValidationError(`A template already uses the key “${d.key}”.`);
    }

    const row = await prisma.paymentTemplate.update({
      where: { id },
      data: {
        ...(d.key ? { key: d.key } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.name ? { name: d.name } : {}),
        ...(d.stage !== undefined ? { stage: d.stage } : {}),
        ...(d.whenToUse !== undefined ? { whenToUse: d.whenToUse || null } : {}),
        ...(d.subject ? { subject: d.subject } : {}),
        ...(d.bodyHtml ? { bodyHtml: sanitizeTemplateHtml(d.bodyHtml) } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paymentTemplate.update',
      entity: 'PaymentTemplate',
      entityId: id,
      details: { key: row.key, changed: Object.keys(d) },
    });
    return row;
  });

  /**
   * Retire a template. Anything built in, or anything already used, is switched
   * off rather than deleted — the history names it, and a name that resolves to
   * nothing is a worse record than one that resolves to something retired.
   */
  app.delete('/admin/payment-templates/:id', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.paymentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const used = await prisma.paymentRequestEmail.count({
      where: { OR: [{ letterTemplateKey: existing.key }, { emailTemplateKey: existing.key }] },
    });
    if (existing.isBuiltIn || used) {
      await prisma.paymentTemplate.update({ where: { id }, data: { active: false } });
      await recordAudit({
        actorId: req.user!.sub,
        action: 'paymentTemplate.retire',
        entity: 'PaymentTemplate',
        entityId: id,
        details: { key: existing.key, used },
      });
      return { retired: true, deleted: false };
    }
    await prisma.paymentTemplate.delete({ where: { id } });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paymentTemplate.delete',
      entity: 'PaymentTemplate',
      entityId: id,
      details: { key: existing.key },
    });
    return reply.status(204).send();
  });

  /** Put a built-in template back the way it shipped, for when an edit has gone wrong. */
  app.post('/admin/payment-templates/:id/reset', manage, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.paymentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Template not found');
    const original =
      existing.key === DEFAULT_EMAIL_TEMPLATE.key
        ? DEFAULT_EMAIL_TEMPLATE
        : DEFAULT_LETTER_TEMPLATES.find((t) => t.key === existing.key);
    if (!original) {
      throw new ValidationError(
        'This template was not one of the originals, so there is nothing to restore.',
      );
    }
    const row = await prisma.paymentTemplate.update({
      where: { id },
      data: {
        name: original.name,
        stage: original.stage,
        whenToUse: original.whenToUse,
        subject: original.subject,
        bodyHtml: original.bodyHtml,
        active: true,
        updatedById: req.user!.sub,
      },
    });
    await recordAudit({
      actorId: req.user!.sub,
      action: 'paymentTemplate.reset',
      entity: 'PaymentTemplate',
      entityId: id,
      details: { key: existing.key },
    });
    return row;
  });

  /** Which environment the figures on screen belong to, for the header. */
  app.get('/receivables/environment', read, async () => ({
    environment: qboEnvironment() as QboEnvironment,
  }));
}

/**
 * The three values the sender types in, trimmed and length-capped.
 *
 * Only the declared entered fields are accepted. Letting the browser post
 * arbitrary merge values would let it overwrite the balance the letter states,
 * which is the one figure that must come from QuickBooks.
 */
export function sanitizeEntered(entered: Record<string, string> | undefined): MergeValues {
  const out: MergeValues = {};
  for (const key of ENTERED_FIELDS) {
    const v = String(entered?.[key] ?? '').trim();
    if (v) out[key] = v.slice(0, 120);
  }
  return out;
}

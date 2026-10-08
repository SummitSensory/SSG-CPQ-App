import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';
import { renderPurchaseOrderHtml, purchaseOrderFilename } from './purchaseOrderDocument.js';
import {
  pushPurchaseOrderToMonday,
  type PurchaseOrderPushResult,
} from '../integrations/monday/purchaseOrderPush.js';

/**
 * Emailing a purchase order, on the same terms as the RFQ and BOM sends: the
 * attachment is built before the provider is called, so a vendor never receives a
 * covering note with no document, and every attempt leaves a send row behind.
 *
 * A successful send freezes the PO and then records it on the Manufacturing Process
 * board (integrations/monday/purchaseOrderPush.ts). That runs after the email and
 * cannot fail the send.
 *
 * Sending a sent PO again is allowed — a vendor mislays an email — and keeps its
 * number: the number is what the vendor invoices against and what monday carries,
 * so unlike an RFQ it does not take a resubmission suffix.
 */

const RESEND_URL = 'https://api.resend.com/emails';

const DEFAULT_SUBJECT = 'Purchase Order {{reference}} — {{customer}}';
const DEFAULT_BODY = `Hello,

Please find attached Purchase Order {{reference}} for the items listed.

Ship-to details and the point of contact are on the document. Please reply to confirm receipt and your expected ship date, and reference the PO number on your invoice.

Thank you,
Summit Sensory Gym`;

export interface PurchaseOrderSendInput {
  /** The person at the vendor it is addressed to — kept on the send record. */
  toName?: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addresses(list: string | undefined): string[] {
  return (list ?? '')
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Plain text to paragraphs and <br>s, which Outlook honours (see freightRfqSend.ts). */
function bodyHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = escaped
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 14px;">${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#20241f;">${paragraphs}</div>`;
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

const money = (minor: number) =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * What the send dialog opens with: the vendor's PO address and wording, falling back
 * to where their Bill of Materials goes, then their primary contact.
 */
export async function purchaseOrderSendDefaults(poId: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { order: { select: { organizationId: true } } },
  });
  if (!po) throw new NotFoundError('Purchase order not found');
  const [mfr, org] = await Promise.all([
    po.manufacturerId
      ? prisma.manufacturer.findUnique({
          where: { id: po.manufacturerId },
          select: {
            poEmailTo: true,
            poEmailCc: true,
            poEmailSubject: true,
            poEmailBody: true,
            bomEmailTo: true,
            bomEmailCc: true,
            contactName: true,
            contactEmail: true,
            altContactName: true,
            altContactEmail: true,
          },
        })
      : null,
    prisma.organization.findUnique({
      where: { id: po.order.organizationId },
      select: { name: true },
    }),
  ]);
  const vars = {
    vendor: po.vendor,
    reference: po.reference,
    customer: org?.name ?? '',
    projectId: po.projectId,
    total: money(po.totalMinor),
  };
  const to = (mfr?.poEmailTo || mfr?.bomEmailTo || mfr?.contactEmail || '').trim();
  // Who that address belongs to, where the profile says: the alternate contact when
  // it is theirs, otherwise the primary contact.
  const first = addresses(to)[0]?.toLowerCase();
  const alt = mfr?.altContactEmail?.trim().toLowerCase();
  const toName = (
    (first && alt && first === alt ? mfr?.altContactName : mfr?.contactName) || ''
  ).trim();
  return {
    toName,
    to,
    cc: (mfr?.poEmailCc || mfr?.bomEmailCc || '').trim(),
    subject: renderTemplate(mfr?.poEmailSubject || DEFAULT_SUBJECT, vars),
    body: renderTemplate(mfr?.poEmailBody || DEFAULT_BODY, vars),
    reference: po.reference,
    vendor: po.vendor,
    status: po.status,
  };
}

export async function sendPurchaseOrder(
  poId: string,
  input: PurchaseOrderSendInput,
  actorId: string,
) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: true, order: { select: { status: true } } },
  });
  if (!po) throw new NotFoundError('Purchase order not found');
  // A draft raised before the order was unlocked must not reach the vendor afterwards.
  if (po.order.status === 'CANCELLED')
    throw new ValidationError(
      'This order has been cancelled, so its purchase orders cannot be sent.',
    );
  if (!po.lines.length) throw new ValidationError('A purchase order needs at least one product.');
  // The freight has to be decided before a vendor sees the total: either an amount,
  // or an explicit "no freight charge". A blank would print as TBD on a document the
  // vendor bills against.
  if (po.freightMinor == null && !po.noFreightCharge) {
    throw new ValidationError(
      'Add the shipping / freight cost to the purchase order (or mark it as no freight charge) before sending.',
    );
  }

  const to = addresses(input.to);
  const cc = addresses(input.cc);
  if (!to.length) throw new ValidationError('Give at least one recipient');
  for (const a of [...to, ...cc]) {
    if (!EMAIL_RE.test(a)) throw new ValidationError(`“${a}” is not a valid email address`);
  }
  if (!input.subject.trim()) throw new ValidationError('The email needs a subject');

  if (!(await pdfAvailable())) {
    throw new ValidationError(
      'PDF rendering is not available on this deployment, so the purchase order cannot be attached. Nothing was sent.',
    );
  }

  // Stamped before rendering, so the document prints the date it was actually sent.
  // Rolled back below if the email does not go out.
  const firstSend = po.status === 'DRAFT';
  if (firstSend) {
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { sentAt: new Date(), sentById: actorId },
    });
  }
  const undoStamp = async () => {
    if (firstSend) {
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: { sentAt: null, sentById: null },
      });
    }
  };

  let attachment: { filename: string; content: string };
  try {
    const { html, model } = await renderPurchaseOrderHtml(poId);
    const pdf = await renderPdf(html, { format: 'Letter' });
    attachment = {
      filename: `${purchaseOrderFilename(model.reference, model.vendor, model.customerName)}.pdf`,
      content: pdf.toString('base64'),
    };
  } catch (err) {
    logger.error({ err, poId }, 'po send: could not build the attachment');
    await undoStamp();
    throw new ValidationError('Could not build the purchase order document. Nothing was sent.');
  }

  const send = await prisma.purchaseOrderSend.create({
    data: {
      poId,
      toName: input.toName?.trim() || null,
      toEmail: to.join(', '),
      ccEmails: cc.length ? cc.join(', ') : null,
      subject: input.subject.trim(),
      bodyPreview: input.body.slice(0, 500),
      status: 'QUEUED',
      sentById: actorId,
    },
  });
  const fail = async (error: string) => {
    await prisma.purchaseOrderSend.update({
      where: { id: send.id },
      data: { status: 'FAILED', error },
    });
    await undoStamp();
  };

  if (!env.RESEND_API_KEY) {
    const msg = 'No email provider is configured on this deployment (RESEND_API_KEY is unset).';
    await fail(msg);
    throw new ValidationError(msg);
  }

  let providerMessageId: string | undefined;
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to,
        ...(cc.length ? { cc } : {}),
        ...(env.BOM_BCC_EMAIL ? { bcc: [env.BOM_BCC_EMAIL] } : {}),
        // Order confirmations and invoices come back to the orders desk, as the BOM's do.
        reply_to: env.BOM_REPLY_TO,
        subject: input.subject.trim(),
        html: bodyHtml(input.body),
        attachments: [attachment],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const error = `The email provider rejected the send (${res.status}): ${text.slice(0, 300)}`;
      await fail(error);
      throw new ValidationError(error);
    }
    providerMessageId = ((await res.json()) as { id?: string }).id;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const error = err instanceof Error ? err.message : 'Unknown error';
    await fail(error);
    throw new ValidationError(`Could not reach the email provider: ${error}`);
  }

  await prisma.purchaseOrderSend.update({
    where: { id: send.id },
    data: { status: 'SENT', providerMessageId: providerMessageId ?? null },
  });
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT' } });
  // The order's own per-line PO number, where nobody has typed one by hand — on the
  // BOM lines this PO was drafted from. A PO line from before PO lines recorded their
  // BOM line falls back to its part number.
  const lineIds = po.lines.map((l) => l.procurementLineId).filter((v): v is string => !!v);
  const legacySkus = po.lines.filter((l) => !l.procurementLineId).map((l) => l.sku);
  await prisma.procurementLine.updateMany({
    where: {
      orderId: po.orderId,
      vendor: { equals: po.vendor, mode: 'insensitive' },
      OR: [
        ...(lineIds.length ? [{ id: { in: lineIds } }] : []),
        ...(legacySkus.length ? [{ sku: { in: legacySkus } }] : []),
      ],
      poNumber: null,
    },
    data: { poNumber: po.reference },
  });
  await prisma.orderEvent.create({
    data: {
      orderId: po.orderId,
      action: 'po.sent',
      actorId,
      detail: {
        vendor: po.vendor,
        reference: po.reference,
        toName: input.toName?.trim() || null,
        to: to.join(', '),
      } as object,
    },
  });
  logger.info({ poId, vendor: po.vendor, to }, 'po send: sent');

  let mondayPush: PurchaseOrderPushResult;
  try {
    mondayPush = await pushPurchaseOrderToMonday(poId);
  } catch (err) {
    logger.error({ err, poId }, 'po send: monday push threw');
    mondayPush = { pushed: false, error: err instanceof Error ? err.message : String(err) };
  }
  await prisma.purchaseOrder
    .update({ where: { id: poId }, data: { mondayResult: mondayPush as object } })
    .catch(() => undefined);

  return {
    id: send.id,
    status: 'SENT' as const,
    reference: po.reference,
    providerMessageId: providerMessageId ?? null,
    mondayPush,
  };
}

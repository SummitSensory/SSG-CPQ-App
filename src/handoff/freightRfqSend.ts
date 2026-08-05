import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { renderRfqHtml, rfqFilename } from './freightRfqDocument.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';

/**
 * Emailing a Request for Freight, on the same terms as the BOM send: the audit
 * row is written whatever happens, and the attachment is built before the
 * provider is called so a vendor never receives a covering note with no
 * document.
 *
 * One difference. Sending freezes the RFQ. A vendor quoting against a document
 * that can still be edited underneath them is how disputes start.
 */

const RESEND_URL = 'https://api.resend.com/emails';

const DEFAULT_SUBJECT = 'Freight quote request {{reference}} — {{customer}}';
const DEFAULT_BODY = `Hello,

Please provide a freight quote for the items listed in the attached request, {{reference}}.

Ship-to details and the point of contact are on the document. Reply to this message with your quote and any questions.

Thank you,
Summit Sensory Gym`;

export interface RfqSendInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

function addresses(list: string | undefined): string[] {
  return (list ?? '')
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bodyHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#20241f;white-space:pre-wrap;">${escaped}</div>`;
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * What the send dialog opens with: the vendor's stored RFQ address and wording,
 * falling back to their freight contact, then their general contact. A vendor
 * with nothing on file still opens a usable dialog — the rep just types the
 * address.
 */
export async function rfqSendDefaults(rfqId: string) {
  const rfq = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    include: { lines: { where: { included: true } } },
  });
  if (!rfq) throw new NotFoundError('RFQ not found');

  const mfr = rfq.manufacturerId
    ? await prisma.manufacturer.findUnique({
      where: { id: rfq.manufacturerId },
      select: {
        name: true, rfqEnabled: true, rfqEmailTo: true, rfqEmailCc: true,
        rfqEmailSubject: true, rfqEmailBody: true,
        rfqContactName: true, rfqContactEmail: true, rfqContactPhone: true,
        contactEmail: true,
      },
    })
    : null;

  const total = rfq.lines.reduce((t, l) => t + l.extendedCostMinor, 0);
  const vars = {
    vendor: rfq.vendor,
    reference: rfq.reference,
    customer: rfq.shipToName,
    projectId: rfq.projectId,
    total: (total / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
  };

  return {
    to: (mfr?.rfqEmailTo || mfr?.rfqContactEmail || mfr?.contactEmail || '').trim(),
    cc: (mfr?.rfqEmailCc || '').trim(),
    subject: renderTemplate(mfr?.rfqEmailSubject || DEFAULT_SUBJECT, vars),
    body: renderTemplate(mfr?.rfqEmailBody || DEFAULT_BODY, vars),
    contactName: mfr?.rfqContactName ?? null,
    contactPhone: mfr?.rfqContactPhone ?? null,
    rfqEnabled: !!mfr?.rfqEnabled,
    reference: rfq.reference,
    vendor: rfq.vendor,
    status: rfq.status,
  };
}

export async function sendRfq(rfqId: string, input: RfqSendInput, actorId: string) {
  const rfq = await prisma.freightRfq.findUnique({
    where: { id: rfqId },
    include: { lines: { where: { included: true } } },
  });
  if (!rfq) throw new NotFoundError('RFQ not found');
  if (rfq.status === 'SUPERSEDED') throw new ValidationError(`${rfq.reference} has been superseded by a newer revision.`);
  if (rfq.status === 'SENT') throw new ValidationError(`${rfq.reference} has already been sent. Start a revision to send an updated request.`);
  if (!rfq.lines.length) throw new ValidationError('Select at least one item before sending.');

  const to = addresses(input.to);
  const cc = addresses(input.cc);
  if (!to.length) throw new ValidationError('Give at least one recipient');
  for (const a of [...to, ...cc]) {
    if (!EMAIL_RE.test(a)) throw new ValidationError(`“${a}” is not a valid email address`);
  }
  if (!input.subject.trim()) throw new ValidationError('The email needs a subject');

  if (!(await pdfAvailable())) {
    throw new ValidationError('PDF rendering is not available on this deployment, so the RFQ cannot be attached. Nothing was sent.');
  }

  let attachment: { filename: string; content: string };
  try {
    const { html, model } = await renderRfqHtml(rfqId);
    const pdf = await renderPdf(html, { format: 'Letter' });
    attachment = {
      filename: `${rfqFilename(model.reference, model.vendor, model.customerName)}.pdf`,
      content: pdf.toString('base64'),
    };
  } catch (err) {
    logger.error({ err, rfqId }, 'rfq send: could not build the attachment');
    throw new ValidationError('Could not build the RFQ document. Nothing was sent.');
  }

  const send = await prisma.freightRfqSend.create({
    data: {
      rfqId,
      toEmail: to.join(', '),
      ccEmails: cc.length ? cc.join(', ') : null,
      subject: input.subject.trim(),
      bodyPreview: input.body.slice(0, 500),
      status: 'QUEUED',
      sentById: actorId,
    },
  });

  const finish = async (status: 'SENT' | 'FAILED', extra: { providerMessageId?: string; error?: string }) => {
    await prisma.freightRfqSend.update({ where: { id: send.id }, data: { status, ...extra } });
    if (status === 'SENT') {
      // Frozen only on a real send: a failed attempt leaves the RFQ editable so
      // the rep can fix the address and try again without raising a revision.
      await prisma.freightRfq.update({
        where: { id: rfqId },
        data: { status: 'SENT', sentAt: new Date(), sentById: actorId },
      });
    }
  };

  if (!env.RESEND_API_KEY) {
    const msg = 'No email provider is configured on this deployment (RESEND_API_KEY is unset).';
    logger.warn({ rfqId, to }, 'rfq send: no provider configured');
    await finish('FAILED', { error: msg });
    throw new ValidationError(msg);
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
        to,
        ...(cc.length ? { cc } : {}),
        ...(env.BOM_BCC_EMAIL ? { bcc: [env.BOM_BCC_EMAIL] } : {}),
        // Quotes come back to the sales desk, not to the orders inbox the BOM uses.
        reply_to: env.RFQ_REPLY_TO,
        subject: input.subject.trim(),
        html: bodyHtml(input.body),
        attachments: [attachment],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      const error = `The email provider rejected the send (${res.status}): ${text.slice(0, 300)}`;
      await finish('FAILED', { error });
      throw new ValidationError(error);
    }

    const json = (await res.json()) as { id?: string };
    await finish('SENT', { providerMessageId: json.id });
    logger.info({ rfqId, vendor: rfq.vendor, to }, 'rfq send: sent');
    return { id: send.id, status: 'SENT' as const, reference: rfq.reference, providerMessageId: json.id ?? null };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const error = err instanceof Error ? err.message : 'Unknown error';
    await finish('FAILED', { error });
    throw new ValidationError(`Could not reach the email provider: ${error}`);
  }
}

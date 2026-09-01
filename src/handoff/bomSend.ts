import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { renderBomHtml, renderBomXlsx, bomFilename } from './bomDocuments.js';
import { confirmSection, submissionBlockers } from './bomSections.js';
import { renderPdf, pdfAvailable } from '../render/pdf.js';
import type { BomSendFormat } from '@prisma/client';

/**
 * Emailing a Bill of Materials to a vendor.
 *
 * Three things matter here beyond "send the mail":
 *
 *   1. **The audit row is written whatever happens.** A failed send is a fact
 *      worth keeping — it is the difference between "the vendor never replied"
 *      and "we never actually sent it". The row is created before the provider is
 *      called and updated with the outcome.
 *   2. **The attachment is built before the send.** If the PDF renderer is down,
 *      nothing goes out and the operator is told, rather than a vendor receiving
 *      a covering note with no document.
 *   3. **Sending submits the section.** The email IS the submission: the vendor
 *      now holds the document, so the section freezes on a successful send and
 *      the same blockers that guard the Confirm button guard the send. A failed
 *      send leaves the section open — nothing left the building.
 */

const RESEND_URL = 'https://api.resend.com/emails';

export interface SendInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  format: BomSendFormat;
  includeZeroQty?: boolean;
}

/** Split a comma or semicolon separated address list, dropping the blanks. */
function addresses(list: string | undefined): string[] {
  return (list ?? '')
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Plain-text body to simple HTML, preserving the operator's line breaks. */
function bodyHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#20241f;white-space:pre-wrap;">${escaped}</div>`;
}

export async function sendBom(sectionId: string, input: SendInput, actorId: string) {
  const section = await prisma.bomVendorSection.findUnique({
    where: { id: sectionId },
    include: { order: { select: { id: true, number: true } } },
  });
  if (!section) throw new NotFoundError('Bill of Materials section not found');

  const to = addresses(input.to);
  const cc = addresses(input.cc);
  if (!to.length) throw new ValidationError('Give at least one recipient');
  for (const a of [...to, ...cc]) {
    if (!EMAIL_RE.test(a)) throw new ValidationError(`“${a}” is not a valid email address`);
  }
  if (!input.subject.trim()) throw new ValidationError('The email needs a subject');

  // Sending is a submission, so it answers to the submission rules. An already
  // submitted section is being re-sent, which is allowed — the document is
  // unchanged and the blockers were cleared when it first went out.
  if (section.status !== 'SUBMITTED') {
    const blockers = await submissionBlockers(sectionId);
    if (blockers.length) {
      throw new ValidationError(
        `Sending submits this Bill of Materials, and it is not ready: ${blockers.join('; ')}.`,
      );
    }
  }

  const wantsPdf = input.format === 'PDF' || input.format === 'BOTH';
  const wantsExcel = input.format === 'EXCEL' || input.format === 'BOTH';

  // Fail before the audit row exists: this is a precondition, not a send attempt.
  if (wantsPdf && !(await pdfAvailable())) {
    throw new ValidationError(
      'PDF rendering is not available on this deployment. Send as Excel, or install the renderer.',
    );
  }

  const attachments: Array<{ filename: string; content: string }> = [];

  try {
    // The customer name comes off the built document rather than a second query,
    // and it is what leads the filename — a vendor searching their inbox looks for
    // our customer, not our order numbering.
    const { html, doc } = await renderBomHtml(section.orderId, section.vendor, {
      includeZeroQty: input.includeZeroQty,
      // The sheet is prepared by whoever is sending it.
      actorId,
    });
    const base = bomFilename(section.order.number, section.vendor, doc.customer.name);
    if (wantsPdf) {
      const pdf = await renderPdf(html, { format: 'Letter' });
      attachments.push({ filename: `${base}.pdf`, content: pdf.toString('base64') });
    }
    if (wantsExcel) {
      const { buffer } = await renderBomXlsx(section.orderId, section.vendor, {
        includeZeroQty: input.includeZeroQty,
        actorId,
      });
      attachments.push({
        filename: `${base}.xlsx`,
        content: buffer.toString('base64'),
      });
    }
  } catch (err) {
    logger.error({ err, sectionId }, 'bom send: could not build the attachment');
    throw new ValidationError('Could not build the document to attach. Nothing was sent.');
  }

  const send = await prisma.bomSend.create({
    data: {
      sectionId,
      orderId: section.orderId,
      vendor: section.vendor,
      toEmail: to.join(', '),
      ccEmails: cc.length ? cc.join(', ') : null,
      subject: input.subject.trim(),
      bodyPreview: input.body.slice(0, 500),
      format: input.format,
      status: 'QUEUED',
      sentById: actorId,
    },
  });

  const finish = async (
    status: 'SENT' | 'FAILED',
    extra: { providerMessageId?: string; error?: string },
  ) => {
    await prisma.bomSend.update({ where: { id: send.id }, data: { status, ...extra } });
    await prisma.orderEvent.create({
      data: {
        orderId: section.orderId,
        action: status === 'SENT' ? 'bom.emailed' : 'bom.email.failed',
        actorId,
        detail: {
          vendor: section.vendor,
          to: to.join(', '),
          format: input.format,
          ...(extra.error ? { error: extra.error } : {}),
        } as object,
      },
    });
  };

  // No key configured: log the attempt honestly rather than reporting a success
  // that never happened.
  if (!env.RESEND_API_KEY) {
    const msg = 'No email provider is configured on this deployment (RESEND_API_KEY is unset).';
    logger.warn({ sectionId, to }, 'bom send: no provider configured');
    await finish('FAILED', { error: msg });
    throw new ValidationError(msg);
  }

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
        reply_to: env.BOM_REPLY_TO,
        subject: input.subject.trim(),
        html: bodyHtml(input.body),
        attachments,
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

    // The vendor has it: freeze the section. The lock is a consequence of the
    // send, never a reason to fail it — if this throws, the mail is already gone,
    // so the error is logged and the send still reports success.
    let submitted = section.status === 'SUBMITTED';
    try {
      await confirmSection(sectionId, actorId);
      submitted = true;
    } catch (err) {
      logger.error({ err, sectionId }, 'bom send: sent, but could not submit the section');
    }

    logger.info({ sectionId, vendor: section.vendor, to }, 'bom send: sent');
    return { id: send.id, status: 'SENT' as const, providerMessageId: json.id ?? null, submitted };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const error = err instanceof Error ? err.message : 'Unknown error';
    await finish('FAILED', { error });
    throw new ValidationError(`Could not reach the email provider: ${error}`);
  }
}

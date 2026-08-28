/**
 * Scheduled report delivery.
 *
 * One endpoint, called daily by Vercel Cron. It looks for saved reports whose
 * schedule says today, runs them, and emails the table as HTML with a CSV attached.
 *
 * Its own endpoint rather than a block inside /cron/portal-delivery: this one sends
 * mail, and a mail send should not be able to delay an integration retry or be
 * delayed by one.
 *
 * Sending uses the report owner's own Outlook connection — the same mechanism the
 * receivables letters use. A report whose owner has never connected Outlook cannot
 * be sent, and that is recorded on the report where the person who scheduled it will
 * see it, rather than logged into the void.
 *
 * Idempotent within a day: `lastSentAt` is checked before sending, so a double cron
 * fire or a manual re-run does not send the same report twice.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { buildDataset } from '../reporting/dataset.js';
import {
  runReport,
  BASIS_LABEL,
  type ReportDefinition,
  type ReportResult,
} from '../reporting/query.js';
import { sendOutlookMail } from '../integrations/microsoft/graph.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (minor: number): string =>
  `$${(Number(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function cell(value: unknown, kind: string): string {
  if (kind === 'money') return money(Number(value) || 0);
  if (kind === 'pct') return `${Number(value) || 0}%`;
  if (kind === 'int') return (Number(value) || 0).toLocaleString();
  return esc(value);
}

/**
 * The report as an email.
 *
 * Table styling is inline and plain: this has to survive Outlook's renderer, which
 * discards a stylesheet without saying so.
 */
function reportHtml(name: string, res: ReportResult, windowLabel: string): string {
  const head = res.columns
    .map(
      (c) =>
        `<th style="text-align:${c.align};padding:7px 10px;border-bottom:2px solid #203060;font:600 11px/1.3 Arial,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#5b6478;">${esc(c.label)}</th>`,
    )
    .join('');
  const body = res.rows
    .slice(0, 200)
    .map(
      (r) =>
        `<tr>${res.columns
          .map(
            (c) =>
              `<td style="text-align:${c.align};padding:6px 10px;border-bottom:1px solid #eceef4;font:13px/1.4 Arial,sans-serif;color:#20241f;white-space:nowrap;">${cell(r[c.key], c.kind)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const totals = res.columns
    .map(
      (c, i) =>
        `<td style="text-align:${c.align};padding:7px 10px;border-top:2px solid #203060;font:700 13px/1.4 Arial,sans-serif;color:#203060;white-space:nowrap;">${
          i === 0 ? 'Total' : c.kind === 'text' ? '' : cell(res.totals[c.key], c.kind)
        }</td>`,
    )
    .join('');

  return (
    `<div style="font:14px/1.5 Arial,sans-serif;color:#20241f;">` +
    `<div style="font:700 18px/1.3 Georgia,serif;color:#203060;">${esc(name)}</div>` +
    `<div style="font:13px/1.5 Arial,sans-serif;color:#5b6478;margin:3px 0 14px;">${esc(windowLabel)} · dated by ${esc(BASIS_LABEL[res.definition.dateBasis])} · ${res.meta.proposalsMatched} proposal${res.meta.proposalsMatched === 1 ? '' : 's'} matched</div>` +
    `<table style="border-collapse:collapse;"><thead><tr>${head}</tr></thead><tbody>${body}${`<tr>${totals}</tr>`}</tbody></table>` +
    (res.rows.length > 200
      ? `<div style="font:12px/1.5 Arial,sans-serif;color:#8a8f85;margin-top:8px;">Showing the first 200 rows. The attached CSV has all ${res.rows.length}.</div>`
      : '') +
    (res.meta.notes.length
      ? `<div style="font:12px/1.5 Arial,sans-serif;color:#8a8f85;margin-top:8px;">${res.meta.notes.map(esc).join(' ')}</div>`
      : '') +
    `<div style="font:12px/1.5 Arial,sans-serif;color:#8a8f85;margin-top:14px;">Sent on a schedule from Summit Sensory Gym's proposal software. Change or stop it under Insights → Saved reports.</div>` +
    `</div>`
  );
}

function reportCsv(res: ReportResult): string {
  const q = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [res.columns.map((c) => q(c.label)).join(',')];
  for (const r of res.rows) {
    lines.push(
      res.columns
        .map((c) => (c.kind === 'money' ? q((Number(r[c.key]) || 0) / 100) : q(r[c.key])))
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/** Whether a cadence is due today. Weekly: 1 = Monday. Monthly: day of month. */
function dueToday(cadence: string, day: number | null, now: Date): boolean {
  if (cadence === 'WEEKLY') {
    const iso = ((now.getUTCDay() + 6) % 7) + 1; // 1 Mon … 7 Sun
    return iso === (day ?? 1);
  }
  if (cadence === 'MONTHLY') return now.getUTCDate() === Math.min(28, Math.max(1, day ?? 1));
  return false;
}

/**
 * The window a scheduled run covers: the completed week or month before today. A
 * schedule that reported "up to this morning" would give a Monday report seven days
 * of one week and none of the next, which makes two consecutive emails
 * incomparable.
 */
function scheduleWindow(cadence: string, now: Date): { from: string; to: string; label: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  if (cadence === 'MONTHLY') {
    const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(firstOfThis.getTime() - 86_400_000);
    return {
      from: start.toISOString().slice(0, 10),
      to: last.toISOString().slice(0, 10),
      label: `${start.toISOString().slice(0, 10)} to ${last.toISOString().slice(0, 10)}`,
    };
  }
  const start = new Date(end.getTime() - 6 * 86_400_000);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
  };
}

export function registerInsightCronRoutes(app: FastifyInstance): void {
  app.post('/cron/scheduled-reports', async (req, reply) => {
    if (!env.CRON_SECRET) return reply.status(503).send({ error: 'CRON_SECRET_NOT_SET' });
    if ((req.headers.authorization ?? '') !== `Bearer ${env.CRON_SECRET}`) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' });
    }

    const started = Date.now();
    const now = new Date();
    const out: Record<string, unknown> = { ranAt: now.toISOString() };
    const results: { report: string; status: string; detail?: string }[] = [];

    try {
      const rows = await prisma.savedReport.findMany({
        where: { cadence: { in: ['WEEKLY', 'MONTHLY'] } },
      });
      // Forced, not cached: a scheduled send must not report a figure that was true
      // a minute before midnight on somebody else's page view.
      const data = rows.length ? await buildDataset(true) : null;

      for (const r of rows) {
        if (!dueToday(r.cadence, r.scheduleDay, now)) continue;
        // Already sent today. Cheap insurance against a double fire.
        if (
          r.lastSentAt &&
          r.lastSentAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
        ) {
          results.push({ report: r.name, status: 'already-sent-today' });
          continue;
        }
        const to = String(r.recipients ?? '')
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((email) => ({ email }));
        if (!to.length) {
          results.push({ report: r.name, status: 'no-recipients' });
          continue;
        }
        const sender = r.sendAsId ?? r.createdById;
        const win = scheduleWindow(r.cadence, now);

        try {
          const res = runReport(data!, {
            ...(r.definition as unknown as ReportDefinition),
            from: win.from,
            to: win.to,
          });
          const csv = reportCsv(res);
          await sendOutlookMail({
            userId: sender,
            to,
            subject: `${r.name} — ${win.label}`,
            html: reportHtml(r.name, res, win.label),
            attachments: [
              {
                filename: `${
                  r.name
                    .replace(/[^\w .-]+/g, ' ')
                    .trim()
                    .slice(0, 60) || 'report'
                }.csv`,
                contentType: 'text/csv',
                bytes: Buffer.from(csv, 'utf8'),
              },
            ],
          });
          await prisma.savedReport.update({
            where: { id: r.id },
            data: { lastSentAt: new Date(), lastSendError: null },
          });
          results.push({ report: r.name, status: 'sent', detail: `${res.rows.length} rows` });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Recorded on the report, not just in the log: the person who scheduled it
          // is the only one who can fix "Outlook is not connected".
          await prisma.savedReport.update({
            where: { id: r.id },
            data: { lastSendError: message.slice(0, 500) },
          });
          logger.error({ err, report: r.name }, 'cron: scheduled report failed to send');
          results.push({ report: r.name, status: 'failed', detail: message });
        }
      }
      out.reports = results;
    } catch (err) {
      logger.error({ err }, 'cron: scheduled reports sweep failed');
      out.reports = { error: err instanceof Error ? err.message : String(err) };
    }

    out.ms = Date.now() - started;
    logger.info(out, 'cron: scheduled reports');
    return reply.send(out);
  });
}

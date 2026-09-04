import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Telling a human when the software breaks.
 *
 * Until now a 500 went to the log and nowhere else, which means the first report
 * of a fault was a customer or a staff member noticing something did not work.
 * The `AcceptedOrder.portalOrderItemId` outage is the case in point: the orders
 * screen returned 500 on every request for as long as it took someone to look.
 *
 * Three things keep this from becoming noise, which is the failure mode that makes
 * people mute alerts:
 *
 *   1. **Only genuine faults.** A 4xx, a validation error, a QuickBooks reconnect
 *      prompt — all handled states, none of them alert. Only the unhandled 500 path
 *      and explicitly-reported background failures.
 *   2. **Deduplicated by fingerprint.** The same fault on the same route alerts once
 *      per hour, however many requests hit it. A broken orders list is one email,
 *      not four hundred.
 *   3. **Never throws, never blocks.** Alerting is fire-and-forget. A failure to
 *      send an alert must not turn a 500 into a hung request.
 */

const RESEND_URL = 'https://api.resend.com/emails';

/** Fingerprint → when we last sent it. In-memory, so per warm instance. */
const lastSent = new Map<string, number>();
const DEDUPE_MS = 60 * 60 * 1000;

/**
 * Serverless instances are short-lived, so this map is not a shared cache and the
 * dedupe is best-effort: several cold instances can each send the first one. That is
 * the right trade — under-alerting on a real outage is worse than a duplicate email,
 * and the alternative is a database write on the error path, which is the last place
 * to add a dependency.
 */
function shouldSend(fingerprint: string): boolean {
  const now = Date.now();
  const prev = lastSent.get(fingerprint);
  if (prev && now - prev < DEDUPE_MS) return false;
  lastSent.set(fingerprint, now);
  // Bounded: a long-lived instance seeing many distinct faults must not grow this
  // map without limit.
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) if (now - t > DEDUPE_MS) lastSent.delete(k);
  }
  return true;
}

export interface AlertInput {
  /** One line, the subject. "Database schema is behind the deployed code". */
  title: string;
  /** What happened, in words someone can act on. */
  detail?: string;
  /** The error itself, if there is one. */
  err?: unknown;
  /** Request context, when the fault came from one. */
  route?: string;
  method?: string;
  /** Overrides the derived dedupe key. */
  fingerprint?: string;
  /** Extra fields worth having in the email. */
  context?: Record<string, unknown>;
}

/** Where alerts go. Falls back to the BOM internal copy address. */
function recipients(): string[] {
  const to = env.ALERT_EMAIL ?? env.BOM_BCC_EMAIL;
  return to
    ? to
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

export function isAlertingConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && recipients().length);
}

/**
 * Send an alert. Fire-and-forget by design — callers do not await it, and it
 * swallows its own failures.
 */
export function sendAlert(input: AlertInput): void {
  void deliver(input).catch((err) => logger.error({ err }, 'alert delivery threw'));
}

async function deliver(input: AlertInput): Promise<void> {
  const to = recipients();
  if (!env.RESEND_API_KEY || !to.length) return;

  const err = input.err;
  const message = err instanceof Error ? err.message : err != null ? String(err) : '';
  const name = err instanceof Error ? err.name : '';
  // Prisma error codes are the useful part of the fingerprint: P2022 on /orders is
  // one fault however many rows or requests it touches.
  const code = (err as { code?: string } | null)?.code ?? '';

  const fingerprint =
    input.fingerprint ??
    createHash('sha256')
      .update([input.title, input.route ?? '', name, code, message.slice(0, 200)].join('|'))
      .digest('hex')
      .slice(0, 16);

  if (!shouldSend(fingerprint)) return;

  const stack =
    err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 12).join('\n') : '';
  const body = [
    input.detail ?? '',
    '',
    input.route ? `Where: ${input.method ?? 'GET'} ${input.route}` : '',
    name || code ? `Error: ${[name, code].filter(Boolean).join(' ')}` : '',
    message ? `Message: ${message}` : '',
    '',
    ...Object.entries(input.context ?? {}).map(
      ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
    ),
    '',
    `Environment: ${env.NODE_ENV}${env.VERCEL_URL ? ` (${env.VERCEL_URL})` : ''}`,
    `Time: ${new Date().toISOString()}`,
    stack ? `\n${stack}` : '',
    '',
    // "fault" would be wrong on the business-event alerts (esign completion,
    // countersign-needed) that reuse this same delivery path without an `err` —
    // the dedupe itself is generic, so the wording has to be too.
    'Repeats of this alert are suppressed for an hour.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${env.BOM_FROM_NAME} <${env.BOM_FROM_EMAIL}>`,
      to,
      subject: `[CRM${env.NODE_ENV === 'production' ? '' : ' ' + env.NODE_ENV}] ${input.title}`,
      text: body,
    }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, title: input.title }, 'alert email rejected by Resend');
  }
}

/**
 * Turn a raw error into an alert title someone can act on without reading a stack
 * trace. `P2022` is the one worth naming outright: it means the deployed code
 * expects a column the database does not have, which is always a migration that did
 * not run, and it is always urgent because Prisma selects every known column — so
 * one missing column breaks every query on that table, not just the new feature.
 */
export function describeFault(err: unknown): { title: string; detail: string } {
  const code = (err as { code?: string } | null)?.code;
  const meta = (err as { meta?: Record<string, unknown> } | null)?.meta;

  if (code === 'P2022') {
    const col = String(meta?.column ?? 'a column');
    return {
      title: 'Database schema is behind the deployed code',
      detail:
        `The deployed code expects ${col}, and the database does not have it. A migration did not run.\n\n` +
        'This breaks EVERY query against that table, not just the new feature, so fix it first:\n' +
        '  pnpm db:migrate:deploy\n\n' +
        'No redeploy is needed afterwards.',
    };
  }
  if (code === 'P1001' || code === 'P1002') {
    return {
      title: 'The database is unreachable',
      detail: 'Prisma could not reach the database. Check the provider status and DATABASE_URL.',
    };
  }
  if (code === 'P2002') {
    return {
      title: 'A uniqueness rule was violated',
      detail: `Something tried to create a duplicate of ${String(meta?.target ?? 'a unique field')}.`,
    };
  }
  return {
    title: 'Unhandled server error',
    detail: 'An unexpected fault reached the error handler. The stack trace is below.',
  };
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

/**
 * Serverless entry for SCHEDULED WORK only — everything under /cron/*.
 *
 * It builds the same Fastify app as `api/index.ts`; the split exists purely so the
 * two can be sized differently, like `api/render.ts`. The nightly sweeps read monday
 * and QuickBooks one record at a time (both rate-limit by account), so a run takes
 * as long as the backlog does. Under the main API's 30 s limit they were killed
 * mid-sweep — `/cron/portal-delivery` on 2026-09-28 and `/cron/freight-pull` on
 * 2026-09-29, both "Task timed out after 30 seconds". Raising the main function's
 * limit instead would let every hung page request hold a function for minutes.
 *
 * Duration is set per-function in vercel.json.
 */
const app = buildApp();
// Typed as `unknown` rather than `void`: Fastify's ready() resolves to a
// PromiseLike, not a full Promise, so narrowing it here just fights the compiler
// for no benefit — nothing reads the value.
let ready: Promise<unknown> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= Promise.resolve(app.ready());
  await ready;
  app.server.emit('request', req, res);
}

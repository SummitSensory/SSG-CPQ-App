import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

/**
 * Serverless entry for the DOCUMENT RENDERER only — everything under /render/*.
 *
 * It builds the same Fastify app as `api/index.ts`; the split exists purely so the
 * two can be sized differently. Headless Chromium needs ~1.5 GB and several
 * seconds of cold start, and Vercel bills memory x duration: giving the main API
 * function those limits would charge every page view for a browser it never
 * launches. Keeping the renderer separate means only the export pays for it.
 *
 * Memory and duration are set per-function in vercel.json.
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

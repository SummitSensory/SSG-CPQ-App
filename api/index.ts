import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

// Serverless entry for Vercel. The Fastify instance is built once per warm
// instance and reused across invocations.
const app = buildApp();
let ready: Promise<void> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= app.ready().then(() => undefined);
  await ready;
  app.server.emit('request', req, res);
}

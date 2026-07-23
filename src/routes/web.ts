import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Serves the web client (login + app shell + dashboard). Files live in /public
 * and are read once, lazily, so this stays a no-op for the API-only test suite.
 */
const cache = new Map<string, string>();
function file(name: string): string {
  let body = cache.get(name);
  if (body === undefined) {
    body = readFileSync(join(process.cwd(), 'public', name), 'utf8');
    cache.set(name, body);
  }
  return body;
}

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(file('index.html')));
  app.get('/app.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(file('app.js')));
}

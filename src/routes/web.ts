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

/**
 * The shell and the client are served with no caching. Without this the browser
 * heuristically caches /app.js forever and a deploy silently keeps running the old
 * build — the sidebar build stamp is how you catch it. index.html also carries a
 * ?v= on the script tag so a cached shell can't pull a stale client.
 */
const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', NO_STORE).send(file('index.html')));
  app.get('/app.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', NO_STORE).send(file('app.js')));
}

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

/** Binary assets (icons, logo) get their own cache — they must not be read as UTF-8. */
const binCache = new Map<string, Buffer>();
function binFile(name: string): Buffer {
  let body = binCache.get(name);
  if (body === undefined) {
    body = readFileSync(join(process.cwd(), 'public', name));
    binCache.set(name, body);
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

/** Icons are content-addressed by filename and change only on a rebrand. */
const IMMUTABLE = 'public, max-age=604800';

/** Every static image the shell references. Anything not listed here 404s. */
const IMAGES = [
  'logo.png',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'favicon-192.png',
  'apple-touch-icon.png',
];

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', NO_STORE).send(file('index.html')));
  app.get('/app.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').header('Cache-Control', NO_STORE).send(file('app.js')));

  for (const name of IMAGES) {
    app.get(`/${name}`, async (_req, reply) =>
      reply.type('image/png').header('Cache-Control', IMMUTABLE).send(binFile(name)));
  }

  // Browsers and link unfurlers request /favicon.ico unprompted, ignoring the
  // <link> tags. Serving the 48px PNG here is valid — no .ico container needed —
  // and stops the unhandled 404 from filling the request log.
  app.get('/favicon.ico', async (_req, reply) =>
    reply.type('image/png').header('Cache-Control', IMMUTABLE).send(binFile('favicon-48.png')));
}

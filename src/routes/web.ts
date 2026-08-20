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

/**
 * Legal and integration pages change rarely but must never serve stale for long:
 * Intuit's reviewers fetch them, and a policy correction needs to be visible the
 * same day it ships.
 */
const PUBLIC_PAGE = 'public, max-age=3600';

/**
 * Every script index.html loads. Nothing in /public is served by a directory
 * handler — each file needs a route here or it 404s, and a missing client script
 * fails SILENTLY: the shell renders, the feature that script provides just isn't
 * there. Both of the entries below were shipped with a <script> tag in index.html
 * and no route, so add the file here in the same commit that adds the tag.
 */
const CLIENT_SCRIPTS = ['app.js', 'vendor-colors.js', 'portal-delivery.js'];

/**
 * Scripts injected into the shell as it is served, rather than written into
 * index.html.
 *
 * EMPTY ON PURPOSE — do not add to this list. In production this list cannot work.
 * Vercel matches files in public/ before it applies the rewrites in vercel.json, so
 * a request for / is answered by public/index.html straight from the CDN and this
 * function is never called. Injection only ever ran in local dev, which made a
 * missing <script> tag look fine locally and vanish in production: that is exactly
 * how the portal delivery panel shipped invisible.
 *
 * A client script needs three things in the same commit instead:
 *   1. the file in public/
 *   2. its route in CLIENT_SCRIPTS below
 *   3. a <script> tag in public/index.html
 *
 * The mechanism is kept because it is the only way to add a tag on a host that does
 * serve the shell through Fastify. It is not that host today.
 */
const INJECTED_SCRIPTS: string[] = [];

/** Cache-buster for the injected tags: the deploy's own commit, when it has one. */
const BUILD_TAG = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || String(Date.now());

/**
 * The shell, with the injected script tags added before </body> — after app.js, so
 * a feature script sees the client it decorates. Falls back to the file untouched if
 * the closing tag ever moves.
 */
function shell(): string {
  const html = file('index.html');
  if (!INJECTED_SCRIPTS.length) return html;
  const tags = INJECTED_SCRIPTS.map(
    (name) => `    <script src="/${name}?v=${BUILD_TAG}"></script>`,
  ).join('\n');
  return html.includes('</body>') ? html.replace('</body>', `${tags}\n  </body>`) : html + tags;
}

/** Every static image the shell references. Anything not listed here 404s. */
const IMAGES = [
  'logo.png',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'favicon-192.png',
  'apple-touch-icon.png',
];

/**
 * Pages that must be reachable WITHOUT signing in.
 *
 * Intuit requires a public EULA and privacy policy before it will issue
 * production keys, and its reviewers open the connect and disconnect URLs while
 * signed out. Anything behind the auth wall reads to them as a broken link, so
 * these are plain static files served outside it.
 *
 * They are also the URLs registered in the Intuit developer portal — changing a
 * path here means changing it there too.
 */
const PUBLIC_PAGES: Array<{ route: string; file: string }> = [
  { route: '/legal/privacy', file: 'legal-privacy.html' },
  { route: '/legal/eula', file: 'legal-eula.html' },
  // One page, three paths. Intuit's portal wants a distinct URL per field and
  // rejects a Connect value that duplicates Disconnect, but the instructions a
  // user needs are the same either way — so both land on the same page rather
  // than on two near-identical ones that would drift apart.
  { route: '/quickbooks', file: 'quickbooks.html' },
  { route: '/quickbooks/connect', file: 'quickbooks.html' },
  { route: '/quickbooks/disconnect', file: 'quickbooks.html' },
];

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', NO_STORE).send(shell()),
  );

  for (const name of CLIENT_SCRIPTS) {
    app.get(`/${name}`, async (_req, reply) =>
      reply
        .type('text/javascript; charset=utf-8')
        .header('Cache-Control', NO_STORE)
        .send(file(name)),
    );
  }

  for (const page of PUBLIC_PAGES) {
    app.get(page.route, async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', PUBLIC_PAGE)
        .send(file(page.file)),
    );
  }

  for (const name of IMAGES) {
    app.get(`/${name}`, async (_req, reply) =>
      reply.type('image/png').header('Cache-Control', IMMUTABLE).send(binFile(name)),
    );
  }

  // Browsers and link unfurlers request /favicon.ico unprompted, ignoring the
  // <link> tags. Serving the 48px PNG here is valid — no .ico container needed —
  // and stops the unhandled 404 from filling the request log.
  app.get('/favicon.ico', async (_req, reply) =>
    reply.type('image/png').header('Cache-Control', IMMUTABLE).send(binFile('favicon-48.png')),
  );
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every script index.html loads must be routed, and every routed script must be loaded.
 *
 * `CLIENT_SCRIPTS` in src/routes/web.ts is an allow-list: nothing in public/ is served
 * by a directory handler, so a file with no entry there 404s in local development. That
 * file's own comment describes the consequence — "a missing client script fails
 * SILENTLY: the shell renders, the feature that script provides just isn't there."
 *
 * On 2026-08-28 ten of seventeen tags were missing from the list, including two added
 * that same day. Nothing broke in production (Vercel serves public/ from the CDN before
 * the rewrites apply, so the route list is a local-dev concern), which is precisely why
 * nobody noticed: the failure only appears on the machine of whoever is working on it,
 * as a feature that quietly isn't there.
 *
 * So both directions are asserted. A tag with no route breaks local dev; a route with
 * no tag is dead weight that suggests a script is loaded when it is not.
 */

const root = join(__dirname, '..', '..');

const indexHtml = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const webTs = readFileSync(join(root, 'src', 'routes', 'web.ts'), 'utf8');

/** Script tags in the shell, ignoring the ?v= cache-buster. */
function taggedScripts(): string[] {
  return [...indexHtml.matchAll(/<script src="\/([^"?]+\.js)/g)].map((m) => m[1]!);
}

/** The allow-list, read out of the source rather than imported — web.ts pulls in the
 *  whole Fastify app, and this test should not need a server to answer a text question. */
function routedScripts(): string[] {
  const block = webTs.match(/const CLIENT_SCRIPTS = \[([\s\S]*?)\];/);
  expect(block, 'CLIENT_SCRIPTS not found in src/routes/web.ts').toBeTruthy();
  return [...block![1]!.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]!);
}

describe('client scripts', () => {
  it('routes every script the shell loads', () => {
    const missing = taggedScripts().filter((s) => !routedScripts().includes(s));
    expect(
      missing,
      `These have a <script> tag in public/index.html but no entry in CLIENT_SCRIPTS, ` +
        `so they 404 in local dev and the feature silently disappears: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('loads every script it routes', () => {
    const unused = routedScripts().filter((s) => !taggedScripts().includes(s));
    expect(
      unused,
      `These are in CLIENT_SCRIPTS but have no <script> tag, which reads as though they ` +
        `are loaded when they are not: ${unused.join(', ')}`,
    ).toEqual([]);
  });

  it('lists no script twice', () => {
    const routed = routedScripts();
    expect(new Set(routed).size).toBe(routed.length);
    const tagged = taggedScripts();
    expect(new Set(tagged).size).toBe(tagged.length);
  });

  it('loads the shared primitives first of all', () => {
    // window.SSGUI holds esc, td, fmtMoney, openModal and the rest — the pieces
    // app.js and every screen script alias on load. app.js throws on boot without
    // it, so this is not a preference about ordering: any tag placed above it is a
    // script that runs before the primitives exist.
    const tags = taggedScripts();
    expect(tags[0], `ssg-ui.js must be the first <script> tag, not ${tags[0]}`).toBe('ssg-ui.js');
  });

  it('keeps the proposal document loaded before app.js', () => {
    // app.js hands the renderer its shared business rules during boot. Loading it
    // after would leave the first render without a deposit rule — and the renderer
    // throws on a missing one rather than guessing, so this ordering is load-bearing.
    const tags = taggedScripts();
    const doc = tags.indexOf('proposal-document.js');
    const app = tags.indexOf('app.js');
    expect(doc).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThanOrEqual(0);
    expect(doc).toBeLessThan(app);
  });
});

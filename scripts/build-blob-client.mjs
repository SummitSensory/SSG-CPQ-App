import { build } from 'esbuild';

/**
 * Vendors @vercel/blob's browser-safe client upload code into a static file
 * public/vendor/vercel-blob-client.mjs, so the browser can PUT a large design
 * rendering straight to blob storage without the bytes ever passing through our
 * Fastify server — the only way past the ~4.5 MB Vercel serverless function body
 * limit that every other upload path in this repo is bounded by.
 *
 * A hand-written fetch call was considered and rejected: the current client-token
 * wire protocol (store-id headers, request ids, presigned vs. bearer auth) is
 * meaningfully more involved than the simple PUT lib/fileStore.ts makes with a
 * full read-write token, and re-deriving it from a decompiled bundle is exactly
 * the kind of guess that produced the x-vercel-blob-access bug earlier in this
 * project's history. Bundling the real package sidesteps the guessing entirely.
 *
 * `platform: 'browser'` makes esbuild honour @vercel/blob's own package.json
 * `browser` field, which remaps its Node-only `undici`/`crypto`/`stream` imports
 * to the browser-safe shims the package ships for exactly this purpose.
 *
 * Run this again only when @vercel/blob is upgraded — the output is committed,
 * not generated during the Vercel build, the same way public/app.js and
 * public/ssg-ui.js are committed rather than built.
 */
await build({
  entryPoints: ['scripts/blob-client-entry.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
  outfile: 'public/vendor/vercel-blob-client.mjs',
  minify: true,
  legalComments: 'none',
});

console.log('Wrote public/vendor/vercel-blob-client.mjs');

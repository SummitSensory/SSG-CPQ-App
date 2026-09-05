// Bundled by scripts/build-blob-client.mjs into public/vendor/vercel-blob-client.mjs.
// See that script for why this exists rather than a hand-rolled fetch: the client
// upload wire protocol is not something worth re-deriving from a decompiled bundle.
import { put } from '@vercel/blob/client';

// `put()`, not `upload()` — `upload()` always requires a `handleUploadUrl`
// server callback route, which this app doesn't have. This app's server
// mints a scoped client token directly (renderingStore.ts's
// issueRenderingUploadToken), and `put()` is the client function that
// uploads with a token like that.
window.SSGBlobUpload = put;

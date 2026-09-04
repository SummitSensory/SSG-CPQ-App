// Bundled by scripts/build-blob-client.mjs into public/vendor/vercel-blob-client.mjs.
// See that script for why this exists rather than a hand-rolled fetch: the client
// upload wire protocol is not something worth re-deriving from a decompiled bundle.
import { upload } from '@vercel/blob/client';

window.SSGBlobUpload = upload;

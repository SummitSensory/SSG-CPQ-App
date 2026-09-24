/**
 * The real dependencies a generation run uses: the Canva client over the stored
 * connection, and the blob file store. Kept apart from service.ts so the service can
 * be exercised with stubs and nothing in a test can reach Canva or Blob.
 */
import { env, isCanvaConfigured } from '../config/env.js';
import { getFile, isFileStoreConfigured, putFile } from '../lib/fileStore.js';
import { createCanvaClient } from '../integrations/canva/client.js';
import { canvaAccessToken, canvaStatus } from '../integrations/canva/oauth.js';
import { type GenerationDeps, newRunId } from './service.js';

export function productionDeps(): GenerationDeps {
  return {
    canva: async () =>
      createCanvaClient({ baseUrl: env.CANVA_API_URL, accessToken: () => canvaAccessToken() }),
    canvaReady: async () => isCanvaConfigured() && (await canvaStatus()).connected,
    getFile: (url) => getFile(url),
    putFile: (pathname, bytes, contentType) => putFile(pathname, bytes, contentType),
    fileStoreConfigured: () => isFileStoreConfigured(),
    now: () => new Date(),
    newRunId,
  };
}

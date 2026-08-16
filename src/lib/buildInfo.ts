import { BUILD_STAMP } from './buildStamp.js';

/**
 * What is deployed right now.
 *
 * The values come from a generated module (see scripts/build-stamp.mjs), with the Vercel
 * environment as a fallback for anything the stamp is missing — a deployment that skipped
 * the stamp script still knows its own commit, it just cannot know when it was built.
 *
 * Resolved once at module load. It cannot change while the process lives: a new deploy is
 * a new process.
 */
export interface BuildInfo {
  /** When the deployment was built. */
  builtAt: string | null;
  /** When the deployed commit was made — the date the files were actually pushed. */
  committedAt: string | null;
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  /** First line of the commit message, so the sidebar can say what changed. */
  message: string | null;
  author: string | null;
  environment: string | null;
}

function resolve(): BuildInfo {
  const env = process.env;
  const commit = BUILD_STAMP.commit ?? env.VERCEL_GIT_COMMIT_SHA ?? null;
  const message =
    BUILD_STAMP.message ?? (env.VERCEL_GIT_COMMIT_MESSAGE ?? '').split('\n')[0] ?? null;
  return {
    builtAt: BUILD_STAMP.builtAt,
    committedAt: BUILD_STAMP.committedAt,
    commit,
    shortCommit: BUILD_STAMP.shortCommit ?? (commit ? commit.slice(0, 7) : null),
    branch: BUILD_STAMP.branch ?? env.VERCEL_GIT_COMMIT_REF ?? null,
    message: message || null,
    author: BUILD_STAMP.author ?? env.VERCEL_GIT_COMMIT_AUTHOR_NAME ?? null,
    environment: BUILD_STAMP.environment ?? env.VERCEL_ENV ?? env.NODE_ENV ?? 'development',
  };
}

export const BUILD_INFO: BuildInfo = resolve();

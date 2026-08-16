import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { BUILD_INFO } from '../lib/buildInfo.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/health/db', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'reachable' };
  });

  /**
   * What is deployed.
   *
   * Unauthenticated, because the shell asks for it while the login screen is still up —
   * knowing which build you are looking at matters most when something is behaving
   * oddly before you can get in. Nothing here is sensitive: a commit sha and its subject
   * line say what changed, not how anything works.
   */
  app.get('/build-info', async () => BUILD_INFO);
}

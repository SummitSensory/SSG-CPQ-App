import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/health/db', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'reachable' };
  });
}

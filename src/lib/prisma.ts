import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

export const prisma = new PrismaClient();

export async function assertDbConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  logger.info('database connection ok');
}

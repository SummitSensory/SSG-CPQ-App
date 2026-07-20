import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertDbConnection } from './lib/prisma.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  await assertDbConnection();
  const app = buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`server listening on :${env.PORT}`);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProtectedRoutes } from './routes/protected.js';
import { registerCrmRoutes } from './routes/crm.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerPricingRoutes } from './routes/pricing.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerApprovalRoutes } from './routes/approvals.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });
  app.register(helmet);
  registerErrorHandler(app);
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerProtectedRoutes(app);
  registerCrmRoutes(app);
  registerIntegrationRoutes(app);
  registerCatalogRoutes(app);
  registerRuleRoutes(app);
  registerPricingRoutes(app);
  registerProposalRoutes(app);
  registerApprovalRoutes(app);
  return app;
}

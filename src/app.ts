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
import { registerQuickbooksRoutes } from './routes/quickbooks.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerPricingRoutes } from './routes/pricing.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerProposalTemplateRoutes } from './routes/templates.js';
import { registerAdventureRoutes } from './routes/adventure.js';
import { registerSkuRoutes } from './routes/skus.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerWebRoutes } from './routes/web.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });
  registerErrorHandler(app);
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerProtectedRoutes(app);
  registerCrmRoutes(app);
  registerIntegrationRoutes(app);
  registerQuickbooksRoutes(app);
  registerCatalogRoutes(app);
  registerRuleRoutes(app);
  registerPricingRoutes(app);
  registerProposalRoutes(app);
  registerProposalTemplateRoutes(app);
  registerAdventureRoutes(app);
  registerSkuRoutes(app);
  registerApprovalRoutes(app);
  registerOrderRoutes(app);
  registerWebRoutes(app);
  return app;
}

import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSsoRoutes } from './routes/sso.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProtectedRoutes } from './routes/protected.js';
import { registerCrmRoutes } from './routes/crm.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerQuickbooksRoutes } from './routes/quickbooks.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerCatalogItemRoutes } from './routes/catalogItems.js';
import { registerManufacturerRoutes } from './routes/manufacturers.js';
import { registerProductTreeRoutes } from './routes/productTree.js';
import { registerBundleRoutes } from './routes/bundles.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerPricingRoutes } from './routes/pricing.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerProposalTemplateRoutes } from './routes/templates.js';
import { registerAdventureRoutes } from './routes/adventure.js';
import { registerSoarRoutes } from './routes/soar.js';
import { registerSkuRoutes } from './routes/skus.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerStandardNoteRoutes } from './routes/standardNotes.js';
import { registerFormulaRoutes } from './routes/formulas.js';
import { registerWebRoutes } from './routes/web.js';

export function buildApp(): FastifyInstance {
  // Fastify infers pino's concrete Logger from `loggerInstance`, which is not
  // structurally assignable to the FastifyBaseLogger the register* helpers
  // expect. The instance is identical at runtime — this pins the public type.
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
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
  registerSsoRoutes(app);
  registerAdminRoutes(app);
  registerProtectedRoutes(app);
  registerCrmRoutes(app);
  registerIntegrationRoutes(app);
  registerQuickbooksRoutes(app);
  registerCatalogRoutes(app);
  registerCatalogItemRoutes(app);
  registerManufacturerRoutes(app);
  registerProductTreeRoutes(app);
  registerBundleRoutes(app);
  registerRuleRoutes(app);
  registerPricingRoutes(app);
  registerProposalRoutes(app);
  registerProposalTemplateRoutes(app);
  registerAdventureRoutes(app);
  registerSoarRoutes(app);
  registerSkuRoutes(app);
  registerApprovalRoutes(app);
  registerOrderRoutes(app);
  registerReportRoutes(app);
  registerStandardNoteRoutes(app);
  registerFormulaRoutes(app);
  registerWebRoutes(app);
  return app;
}

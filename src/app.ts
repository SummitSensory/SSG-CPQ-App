import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerFreightGate } from './plugins/freightGate.js';
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
import { registerBomRoutes } from './routes/bom.js';
import { registerFreightRfqRoutes } from './routes/freightRfq.js';
import { registerFinanceRoutes } from './routes/finance.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerFreightRoutes } from './routes/freight.js';
import { registerFreightTrueUpRoutes } from './routes/freightTrueUp.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerStandardNoteRoutes } from './routes/standardNotes.js';
import { registerCustomerNoteRoutes } from './routes/customerNotes.js';
import { registerFormulaRoutes } from './routes/formulas.js';
import { registerWebRoutes } from './routes/web.js';

export function buildApp(): FastifyInstance {
  // Fastify infers pino's concrete Logger from `loggerInstance`, which is not
  // structurally assignable to the FastifyBaseLogger the register* helpers
  // expect. The instance is identical at runtime — this pins the public type.
  // 8 MB body limit, up from Fastify's 1 MB default. The proposal send posts the
  // rendered proposal HTML for server-side PDF, and a long itemized proposal with
  // inline styles runs well past 1 MB — the default silently 413s the send.
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 8 * 1024 * 1024,
  }) as unknown as FastifyInstance;
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
  // Keep the raw JSON body alongside the parsed one. The Resend webhook signs the
  // exact bytes it sent, so re-serializing the parsed object would not verify —
  // key order and whitespace differ.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  registerErrorHandler(app);
  // Money policy that spans modules: a Bill of Materials may not go to a vendor
  // while the job's freight is unquoted and unexplained. Registered before the
  // routes so it sees their requests.
  registerFreightGate(app);
  registerHealthRoutes(app);
  registerWebhookRoutes(app);
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
  registerBomRoutes(app);
  registerFreightRfqRoutes(app);
  registerFinanceRoutes(app);
  registerRenderRoutes(app);
  registerFreightRoutes(app);
  registerFreightTrueUpRoutes(app);
  registerReportRoutes(app);
  registerStandardNoteRoutes(app);
  registerCustomerNoteRoutes(app);
  registerFormulaRoutes(app);
  registerWebRoutes(app);
  return app;
}

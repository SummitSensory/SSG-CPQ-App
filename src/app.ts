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
import { registerVendorColorRoutes } from './routes/vendorColors.js';
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
import { registerBomBuildRoutes } from './routes/bomBuild.js';
import { registerFreightRfqRoutes } from './routes/freightRfq.js';
import { registerFinanceRoutes } from './routes/finance.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerFreightRoutes } from './routes/freight.js';
import { registerFreightTrueUpRoutes } from './routes/freightTrueUp.js';
import { registerCrossBorderRoutes } from './routes/crossBorder.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerDocusealWebhookRoutes } from './routes/esignWebhook.js';
import { registerEsignRoutes } from './routes/esign.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerInsightRoutes } from './routes/insights.js';
import { registerStandardNoteRoutes } from './routes/standardNotes.js';
import { registerLegalDocumentRoutes } from './routes/legalDocuments.js';
import { registerCustomerNoteRoutes } from './routes/customerNotes.js';
import { registerFollowUpRoutes } from './routes/followUps.js';
import { registerOutlookRoutes } from './routes/outlook.js';
import { registerReceivableRoutes } from './routes/receivables.js';
import { registerReceivableRenderRoutes } from './routes/receivablesRender.js';
import { registerFormulaRoutes } from './routes/formulas.js';
import { registerIntroTemplateRoutes } from './routes/introTemplates.js';
import { registerBeltShipmentRoutes } from './routes/beltShipments.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerReceivableCronRoutes } from './routes/cronReceivables.js';
import { registerInsightCronRoutes } from './routes/cronInsights.js';
import { registerFxCronRoutes } from './routes/cronFx.js';
import { verifySchemaOnBoot } from './lib/schemaCheck.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerWebRoutes } from './routes/web.js';

export function buildApp(): FastifyInstance {
  // Fastify infers pino's concrete Logger from `loggerInstance`, which is not
  // structurally assignable to the FastifyBaseLogger the register* helpers
  // expect. The instance is identical at runtime — this pins the public type.
  // 8 MB body limit, up from Fastify's 1 MB default. The proposal send posts the
  // rendered proposal HTML for server-side PDF, and a long itemized proposal with
  // inline styles runs well past 1 MB — the default silently 413s the send. It is
  // also what accommodates a base64 purchase-order upload (3 MB of file, a third
  // more once encoded).
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
  // Keep the raw JSON body alongside the parsed one. The Resend and DocuSeal
  // webhooks are checked against the exact bytes they sent, so re-serializing the
  // parsed object would not verify — key order and whitespace differ.
  /*
   * A POST with no body arrives with no Content-Type, and Fastify 5 refuses it.
   *
   * `POST /legal-documents/TERMS/publish` takes no body — the draft to publish is already
   * on the row, so there is nothing to send. The browser therefore sets no Content-Type
   * (see `api()` in public/app.js: the header is added only when there is a body), and
   * Fastify's content-type parser rejects the request with
   * FST_ERR_CTP_INVALID_MEDIA_TYPE, 415, before the route is ever reached. Publishing a
   * legal document failed outright in production.
   *
   * Every body-less POST in the API has the same problem: publish, restore-shipped, and
   * anything added later following the same pattern. So it is fixed once, here, rather
   * than by giving each caller a body it has no reason to send.
   *
   * Declaring the type is all that is needed — the parser below already turns an empty
   * body into `{}` rather than failing on it, which is exactly the case this produces.
   *
   * Only for methods that can carry a body, and only when the header is absent: a request
   * that states its own type keeps it, so multipart uploads and the signature-verified
   * webhooks are untouched.
   */
  app.addHook('onRequest', (req, _reply, done) => {
    const method = req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (!req.headers['content-type']) req.headers['content-type'] = 'application/json';
    }
    done();
  });

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
  registerDocusealWebhookRoutes(app);
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
  registerVendorColorRoutes(app);
  registerProductTreeRoutes(app);
  registerBundleRoutes(app);
  registerRuleRoutes(app);
  registerPricingRoutes(app);
  registerProposalRoutes(app);
  registerProposalTemplateRoutes(app);
  registerIntroTemplateRoutes(app);
  registerBeltShipmentRoutes(app);
  registerAdventureRoutes(app);
  registerSoarRoutes(app);
  registerSkuRoutes(app);
  registerApprovalRoutes(app);
  registerOrderRoutes(app);
  registerBomRoutes(app);
  registerBomBuildRoutes(app);
  registerFreightRfqRoutes(app);
  registerFinanceRoutes(app);
  registerRenderRoutes(app);
  registerEsignRoutes(app);
  registerFreightRoutes(app);
  registerFreightTrueUpRoutes(app);
  registerCrossBorderRoutes(app);
  registerHistoryRoutes(app);
  registerReportRoutes(app);
  registerInsightRoutes(app);
  registerStandardNoteRoutes(app);
  registerLegalDocumentRoutes(app);
  registerCustomerNoteRoutes(app);
  registerFollowUpRoutes(app);
  registerOutlookRoutes(app);
  // Accounts receivable: the balance mirror, the customer's purchase order, and
  // the payment-request composer. Split across two files because the send renders
  // a PDF and therefore has to run on the renderer function — the /render/* half
  // is registered here too, since both serverless entry points build this app and
  // only the rewrite in vercel.json decides which function answers.
  registerReceivableRoutes(app);
  registerReceivableRenderRoutes(app);
  registerFormulaRoutes(app);
  registerCronRoutes(app);
  registerReceivableCronRoutes(app);
  registerInsightCronRoutes(app);
  registerFxCronRoutes(app);
  registerPortalRoutes(app);
  registerWebRoutes(app);

  // Is the database shaped the way this build expects? Not awaited — a slow or
  // failing check must not delay the server accepting requests — and it never
  // throws. It emails when the schema is behind the code, which is the fault that
  // took the orders screen down: Prisma selects every column it knows about, so one
  // missing column breaks every query on that table.
  void verifySchemaOnBoot();

  return app;
}

import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';

/**
 * Thin endpoints guarding each sensitive resource on the SERVER. They contain
 * no CPQ business logic yet — they exist to enforce and prove authorization.
 */
export function registerProtectedRoutes(app: FastifyInstance): void {
  const r = (perm: string) => ({ preHandler: requirePermission(perm) });

  app.get('/internal/costs', r(Permission.COSTS_READ), async () => ({ resource: 'costs' }));
  app.get('/internal/margins', r(Permission.MARGINS_READ), async () => ({ resource: 'margins' }));
  app.post('/internal/discounts/authorize', r(Permission.DISCOUNT_AUTHORIZE), async () => ({ authorized: true }));
  app.get('/internal/accounting', r(Permission.ACCOUNTING_READ), async () => ({ resource: 'accounting' }));
  app.post('/internal/accounting/post', r(Permission.ACCOUNTING_WRITE), async () => ({ posted: true }));
  app.get('/internal/integrations', r(Permission.INTEGRATIONS_MANAGE), async () => ({ resource: 'integrations' }));
  app.get('/internal/products/admin', r(Permission.PRODUCTS_ADMIN), async () => ({ resource: 'products' }));
}

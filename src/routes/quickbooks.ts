import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env, isQuickbooksConfigured, qboEnvironment } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { authorizeUrl, exchangeCode, disconnect } from '../integrations/quickbooks/oauth.js';
import { findOrCreateCustomer } from '../integrations/quickbooks/customers.js';
import { syncItem } from '../integrations/quickbooks/items.js';
import {
  prepareTransaction, authorizeTransaction, executeTransaction, retryTransaction, listTransactions,
} from '../integrations/quickbooks/transactions.js';
import { reconcile } from '../integrations/quickbooks/reconcile.js';
import type { QboEnvironment, QboTxnType } from '@prisma/client';

/** QboTransaction rows carry BigInt columns — serialize to strings for JSON. */
function serializeTxn(t: {
  proposalTotalMinor: bigint; amountMinor: bigint; [k: string]: unknown;
}): Record<string, unknown> {
  return { ...t, proposalTotalMinor: t.proposalTotalMinor.toString(), amountMinor: t.amountMinor.toString() };
}

async function activeRealmId(): Promise<string | null> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment: qboEnvironment() as QboEnvironment, isActive: true } });
  return conn?.realmId ?? null;
}

export function registerQuickbooksRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.QBO_MANAGE) };
  const transact = { preHandler: requirePermission(Permission.QBO_TRANSACT) };

  // --- Status & connection (manage) ---
  app.get('/integrations/quickbooks/status', manage, async () => ({
    provider: 'quickbooks',
    configured: isQuickbooksConfigured(),
    environment: qboEnvironment(),
    productionWritesEnabled: env.QBO_PRODUCTION_WRITE_ENABLED,
    connections: await prisma.qboConnection.count({ where: { environment: qboEnvironment() as QboEnvironment, isActive: true } }),
  }));

  // Begin OAuth: returns the Intuit consent URL. `state` is a CSRF nonce the
  // caller should persist and re-check on callback.
  app.get('/integrations/quickbooks/connect', manage, async () => {
    const state = randomUUID();
    return { url: authorizeUrl(state), state };
  });

  // OAuth redirect target. Exchanges the code for encrypted tokens.
  app.get('/integrations/quickbooks/callback', manage, async (req, reply) => {
    const q = req.query as { code?: string; realmId?: string; state?: string };
    if (!q.code || !q.realmId) return reply.status(400).send({ error: 'MISSING_CODE_OR_REALM' });
    await exchangeCode(q.code, q.realmId, req.user!.sub);
    return { connected: true, realmId: q.realmId, environment: qboEnvironment() };
  });

  app.post('/integrations/quickbooks/disconnect/:realmId', manage, async (req) => {
    const { realmId } = req.params as { realmId: string };
    await disconnect(realmId);
    return { disconnected: true };
  });

  // --- Master-data sync (manage) ---
  app.post('/integrations/quickbooks/customers/:organizationId/sync', manage, async (req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    const { organizationId } = req.params as { organizationId: string };
    return findOrCreateCustomer(organizationId, realmId, req.user!.sub);
  });

  app.post('/integrations/quickbooks/items/:productId/sync', manage, async (req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    const { productId } = req.params as { productId: string };
    const { incomeAccountRef } = (req.body ?? {}) as { incomeAccountRef?: string };
    if (!incomeAccountRef) return reply.status(400).send({ error: 'INCOME_ACCOUNT_REF_REQUIRED' });
    return syncItem(productId, realmId, incomeAccountRef, req.user!.sub);
  });

  // --- Transactions (list = manage; mutate = transact) ---
  app.get('/integrations/quickbooks/transactions', manage, async (req) => {
    const q = req.query as { proposalId?: string };
    const rows = await listTransactions({ proposalId: q.proposalId });
    return rows.map(serializeTxn);
  });

  app.get('/integrations/quickbooks/reconcile', manage, async () => reconcile(env.QBO_PRODUCTION_WRITE_ENABLED));

  const TXN_TYPES: QboTxnType[] = ['ESTIMATE', 'DEPOSIT_INVOICE', 'PROGRESS_INVOICE', 'FINAL_INVOICE'];

  // Prepare: freeze totals + idempotency key. Does NOT touch QuickBooks.
  app.post('/integrations/quickbooks/transactions/prepare', transact, async (req, reply) => {
    const b = (req.body ?? {}) as { proposalVersionId?: string; type?: QboTxnType; sequence?: number };
    if (!b.proposalVersionId || !b.type || !TXN_TYPES.includes(b.type)) {
      return reply.status(400).send({ error: 'INVALID_INPUT' });
    }
    const txn = await prepareTransaction({ proposalVersionId: b.proposalVersionId, type: b.type, sequence: b.sequence }, req.user!.sub);
    return serializeTxn(txn);
  });

  // Explicit authorization — required before any live financial create.
  app.post('/integrations/quickbooks/transactions/:id/authorize', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await authorizeTransaction(id, req.user!.sub));
  });

  // Execute: create the document in QuickBooks (idempotent).
  app.post('/integrations/quickbooks/transactions/:id/execute', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await executeTransaction(id, req.user!.sub));
  });

  // Manual retry of a FAILED transaction (same idempotency key — never duplicates).
  app.post('/integrations/quickbooks/transactions/:id/retry', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await retryTransaction(id, req.user!.sub));
  });
}

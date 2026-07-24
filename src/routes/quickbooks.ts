import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env, isQuickbooksConfigured, qboEnvironment } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { authorizeUrl, exchangeCode, disconnect } from '../integrations/quickbooks/oauth.js';
import { findOrCreateCustomer } from '../integrations/quickbooks/customers.js';
import { syncItem } from '../integrations/quickbooks/items.js';
import {
  prepareTransaction,
  authorizeTransaction,
  executeTransaction,
  retryTransaction,
  listTransactions,
} from '../integrations/quickbooks/transactions.js';
import { reconcile } from '../integrations/quickbooks/reconcile.js';
import type { QboEnvironment, QboTxnType } from '@prisma/client';

/** QboTransaction rows carry BigInt columns — serialize to strings for JSON. */
function serializeTxn(t: {
  proposalTotalMinor: bigint;
  amountMinor: bigint;
  [k: string]: unknown;
}): Record<string, unknown> {
  return {
    ...t,
    proposalTotalMinor: t.proposalTotalMinor.toString(),
    amountMinor: t.amountMinor.toString(),
  };
}

async function activeRealmId(): Promise<string | null> {
  const conn = await prisma.qboConnection.findFirst({
    where: { environment: qboEnvironment() as QboEnvironment, isActive: true },
  });
  return conn?.realmId ?? null;
}

// Intuit redirects the BROWSER back to us with no Authorization header, so the
// callback cannot sit behind requirePermission. Instead the `state` nonce is a
// short-lived signed token naming the admin who started the flow: it doubles as
// CSRF protection and as the identity the token exchange is recorded against.
const stateKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const STATE_TTL = 900;

async function signState(userId: string): Promise<string> {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL)
    .sign(stateKey);
}

async function readState(state: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(state, stateKey);
    return String(payload.uid);
  } catch {
    return null;
  }
}

function resultPage(title: string, detail: string, ok: boolean): string {
  const safe = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe(title)}</title></head>
<body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 24px;color:#20241f;">
<h1 style="font-size:20px;color:${ok ? '#3f9d78' : '#c2452f'};">${safe(title)}</h1>
<p style="color:#82877d;line-height:1.6;">${safe(detail)}</p>
<p><a href="/" style="color:#3d4a55;">Back to the workspace</a></p>
</body></html>`;
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
    connections: await prisma.qboConnection.count({
      where: { environment: qboEnvironment() as QboEnvironment, isActive: true },
    }),
  }));

  // Begin OAuth: returns the Intuit consent URL. `state` is a signed nonce that
  // the callback verifies — the caller just follows the URL.
  app.get('/integrations/quickbooks/connect', manage, async (req, reply) => {
    if (!isQuickbooksConfigured()) return reply.status(409).send({ error: 'NOT_CONFIGURED' });
    const state = await signState(req.user!.sub);
    return { url: authorizeUrl(state), state };
  });

  // OAuth redirect target. Public by necessity (see signState above); the state
  // token is what authenticates it.
  app.get('/integrations/quickbooks/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      realmId?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    reply.type('text/html; charset=utf-8');

    if (q.error)
      return reply
        .status(400)
        .send(resultPage('Connection cancelled', q.error_description ?? q.error, false));
    if (!q.code || !q.realmId || !q.state) {
      return reply
        .status(400)
        .send(resultPage('Connection failed', 'QuickBooks sent an incomplete response.', false));
    }

    const userId = await readState(q.state);
    if (!userId) {
      return reply
        .status(401)
        .send(
          resultPage(
            'Connection failed',
            'That connection request expired. Start again from Administration → Integrations.',
            false,
          ),
        );
    }

    try {
      await exchangeCode(q.code, q.realmId, userId);
      return reply.send(
        resultPage(
          'QuickBooks connected',
          `Connected to company ${q.realmId} in the ${qboEnvironment().toLowerCase()} environment.`,
          true,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The token exchange failed.';
      return reply.status(502).send(resultPage('Connection failed', message, false));
    }
  });

  app.post('/integrations/quickbooks/disconnect/:realmId', manage, async (req) => {
    const { realmId } = req.params as { realmId: string };
    await disconnect(realmId);
    return { disconnected: true };
  });

  // --- Master-data sync (manage) ---
  app.post(
    '/integrations/quickbooks/customers/:organizationId/sync',
    manage,
    async (req, reply) => {
      const realmId = await activeRealmId();
      if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
      const { organizationId } = req.params as { organizationId: string };
      return findOrCreateCustomer(organizationId, realmId, req.user!.sub);
    },
  );

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

  app.get('/integrations/quickbooks/reconcile', manage, async () =>
    reconcile(env.QBO_PRODUCTION_WRITE_ENABLED),
  );

  const TXN_TYPES: QboTxnType[] = [
    'ESTIMATE',
    'DEPOSIT_INVOICE',
    'PROGRESS_INVOICE',
    'FINAL_INVOICE',
  ];

  // Prepare: freeze totals + idempotency key. Does NOT touch QuickBooks.
  app.post('/integrations/quickbooks/transactions/prepare', transact, async (req, reply) => {
    const b = (req.body ?? {}) as {
      proposalVersionId?: string;
      type?: QboTxnType;
      sequence?: number;
    };
    if (!b.proposalVersionId || !b.type || !TXN_TYPES.includes(b.type)) {
      return reply.status(400).send({ error: 'INVALID_INPUT' });
    }
    const txn = await prepareTransaction(
      { proposalVersionId: b.proposalVersionId, type: b.type, sequence: b.sequence },
      req.user!.sub,
    );
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

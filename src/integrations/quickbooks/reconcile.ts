import { prisma } from '../../lib/prisma.js';
import { qboEnvironment } from '../../config/env.js';

/**
 * QuickBooks reconciliation report. Surfaces everything an accountant needs to
 * confirm CPQ and QuickBooks agree: transaction outcomes by status, documents
 * that failed and need a manual retry, transactions awaiting authorization, and
 * entity links in an error state. It never mutates anything — read-only.
 */
export interface QboReconcileReport {
  generatedAt: string;
  environment: string;
  productionWritesEnabled: boolean;
  connections: Array<{ realmId: string; environment: string; isActive: boolean; accessTokenExpiresAt: string }>;
  transactionCounts: Record<string, number>;
  failed: Array<{ id: string; type: string; proposalId: string; amountMinor: string; error: string | null; createdAt: string }>;
  awaitingAuthorization: Array<{ id: string; type: string; proposalId: string; amountMinor: string; initiatedById: string; createdAt: string }>;
  authorizedNotCreated: Array<{ id: string; type: string; proposalId: string; authorizedById: string | null; authorizedAt: string | null }>;
  erroredLinks: Array<{ entity: string; entityId: string; state: string }>;
  recentSyncFailures: Array<{ id: string; entity: string; status: string; error: string | null; createdAt: string }>;
}

export async function reconcile(productionWritesEnabled: boolean): Promise<QboReconcileReport> {
  const environment = qboEnvironment();
  const [txns, connections, links, failures] = await Promise.all([
    prisma.qboTransaction.findMany({ where: { environment }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.qboConnection.findMany({ where: { environment } }),
    prisma.qboEntityLink.findMany({ where: { environment, state: { in: ['ERROR', 'CONFLICT'] } } }),
    prisma.integrationSyncLog.findMany({ where: { provider: 'quickbooks', status: { in: ['error', 'conflict'] } }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  const transactionCounts: Record<string, number> = {};
  for (const t of txns) transactionCounts[t.status] = (transactionCounts[t.status] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    environment,
    productionWritesEnabled,
    connections: connections.map((c) => ({ realmId: c.realmId, environment: c.environment, isActive: c.isActive, accessTokenExpiresAt: c.accessTokenExpiresAt.toISOString() })),
    transactionCounts,
    failed: txns.filter((t) => t.status === 'FAILED').map((t) => ({ id: t.id, type: t.type, proposalId: t.proposalId, amountMinor: t.amountMinor.toString(), error: t.error, createdAt: t.createdAt.toISOString() })),
    awaitingAuthorization: txns.filter((t) => t.status === 'PENDING_AUTHORIZATION').map((t) => ({ id: t.id, type: t.type, proposalId: t.proposalId, amountMinor: t.amountMinor.toString(), initiatedById: t.initiatedById, createdAt: t.createdAt.toISOString() })),
    authorizedNotCreated: txns.filter((t) => t.status === 'AUTHORIZED').map((t) => ({ id: t.id, type: t.type, proposalId: t.proposalId, authorizedById: t.authorizedById, authorizedAt: t.authorizedAt?.toISOString() ?? null })),
    erroredLinks: links.map((l) => ({ entity: l.entity, entityId: l.entityId, state: l.state })),
    recentSyncFailures: failures.map((f) => ({ id: f.id, entity: f.entity, status: f.status, error: f.error, createdAt: f.createdAt.toISOString() })),
  };
}

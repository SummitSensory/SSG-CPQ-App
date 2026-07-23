import { prisma } from '../../lib/prisma.js';

export interface ReconcileReport {
  generatedAt: string;
  drifted: Array<{ entity: string; entityId: string; externalId: string }>;
  errored: Array<{ entity: string; entityId: string; state: string }>;
  recentFailures: Array<{ id: string; entity: string; status: string; error: string | null; createdAt: string }>;
  counts: { links: number; drifted: number; errored: number; recentFailures: number };
}

/**
 * Reconciliation report: surfaces links that need attention. "Drifted" links
 * are LINKED but have no lastSyncedHash (never confirmed synced); errored links
 * are in ERROR/CONFLICT state; recent failures come from the sync log.
 */
export async function reconcile(): Promise<ReconcileReport> {
  const links = await prisma.externalLink.findMany({ where: { provider: 'monday' } });
  const drifted = links
    .filter((l) => l.state === 'LINKED' && !l.lastSyncedHash)
    .map((l) => ({ entity: l.entity, entityId: l.entityId, externalId: l.externalId }));
  const errored = links
    .filter((l) => l.state === 'ERROR' || l.state === 'CONFLICT')
    .map((l) => ({ entity: l.entity, entityId: l.entityId, state: l.state }));

  const failures = await prisma.integrationSyncLog.findMany({
    where: { provider: 'monday', status: { in: ['error', 'conflict'] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const recentFailures = failures.map((f) => ({
    id: f.id, entity: f.entity, status: f.status, error: f.error, createdAt: f.createdAt.toISOString(),
  }));

  return {
    generatedAt: new Date().toISOString(),
    drifted, errored, recentFailures,
    counts: { links: links.length, drifted: drifted.length, errored: errored.length, recentFailures: recentFailures.length },
  };
}

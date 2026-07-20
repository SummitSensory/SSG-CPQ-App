import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface AuditEntry {
  actorId: string;
  action: string;
  targetUserId?: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

/** Append a security-relevant event. Never updates or deletes existing rows. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      details: (entry.details ?? {}) as object,
    },
  });
  logger.info({ action: entry.action, entity: entry.entity }, 'audit');
}

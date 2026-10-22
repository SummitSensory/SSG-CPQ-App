import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  DEFAULT_FRAME_CODE_CONVENTION,
  DEFAULT_FRAME_CODE_VERSION,
  LEGACY_FRAME_CODE_CONVENTION,
  LEGACY_FRAME_CODE_VERSION,
  type FrameCodeConvention,
} from './frameCode.js';

/** The Adventure Series is the only product line with a frame code today. */
export const FRAME_CODE_PRODUCT_LINE = 'ADVENTURE';

export interface VersionedFrameCodeConvention {
  version: number;
  convention: FrameCodeConvention;
  note?: string | null;
  createdAt?: Date | null;
  createdById?: string | null;
}

/**
 * Every version, oldest first: the read-only legacy (0), the default in code (1), then
 * whatever has been saved. A saved row numbered 1 is never written (saves start at 2),
 * so the default cannot be shadowed.
 */
export async function frameCodeConventions(): Promise<VersionedFrameCodeConvention[]> {
  const rows = await prisma.frameCodeConvention.findMany({
    where: { productLine: FRAME_CODE_PRODUCT_LINE, version: { gt: DEFAULT_FRAME_CODE_VERSION } },
    orderBy: { version: 'asc' },
  });
  return [
    { version: LEGACY_FRAME_CODE_VERSION, convention: LEGACY_FRAME_CODE_CONVENTION },
    { version: DEFAULT_FRAME_CODE_VERSION, convention: DEFAULT_FRAME_CODE_CONVENTION },
    ...rows.map((r) => ({
      version: r.version,
      convention: r.config as unknown as FrameCodeConvention,
      note: r.note,
      createdAt: r.createdAt,
      createdById: r.createdById,
    })),
  ];
}

/** The convention new proposals are named with: the newest version. */
export async function activeFrameCodeConvention(): Promise<VersionedFrameCodeConvention> {
  const row = await prisma.frameCodeConvention.findFirst({
    where: { productLine: FRAME_CODE_PRODUCT_LINE, version: { gt: DEFAULT_FRAME_CODE_VERSION } },
    orderBy: { version: 'desc' },
  });
  return row
    ? {
        version: row.version,
        convention: row.config as unknown as FrameCodeConvention,
        note: row.note,
        createdAt: row.createdAt,
        createdById: row.createdById,
      }
    : { version: DEFAULT_FRAME_CODE_VERSION, convention: DEFAULT_FRAME_CODE_CONVENTION };
}

/**
 * Save a new version. Never updates a row: proposals already stamped with the current
 * version must keep reading by it. The caller validates (conventionProblems) first.
 */
export async function saveFrameCodeConvention(
  convention: FrameCodeConvention,
  note: string | null,
  userId: string,
): Promise<VersionedFrameCodeConvention> {
  const current = await activeFrameCodeConvention();
  const row = await prisma.frameCodeConvention.create({
    data: {
      productLine: FRAME_CODE_PRODUCT_LINE,
      version: current.version + 1,
      config: convention as unknown as Prisma.InputJsonValue,
      note,
      createdById: userId,
    },
  });
  return {
    version: row.version,
    convention,
    note: row.note,
    createdAt: row.createdAt,
    createdById: row.createdById,
  };
}

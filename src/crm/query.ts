import { z } from 'zod';

export const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * Build a safe Prisma orderBy from a whitelist. An unknown sort field falls
 * back to the default — user input can never inject an arbitrary column.
 */
export function buildOrderBy(
  sort: string | undefined,
  dir: 'asc' | 'desc',
  allowed: readonly string[],
  fallback: string,
): Record<string, 'asc' | 'desc'> {
  const field = sort && allowed.includes(sort) ? sort : fallback;
  return { [field]: dir };
}

export function paginate(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

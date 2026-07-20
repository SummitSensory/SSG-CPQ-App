import { describe, it, expect } from 'vitest';
import { buildOrderBy, paginate } from '../../src/crm/query.js';

describe('safe query building', () => {
  it('uses an allowed sort field', () => {
    expect(buildOrderBy('name', 'asc', ['name', 'createdAt'], 'createdAt')).toEqual({ name: 'asc' });
  });
  it('falls back when the sort field is not whitelisted (no injection)', () => {
    expect(buildOrderBy('password; DROP TABLE', 'asc', ['name'], 'createdAt')).toEqual({ createdAt: 'asc' });
  });
  it('paginates correctly', () => {
    expect(paginate(3, 20)).toEqual({ skip: 40, take: 20 });
  });
});

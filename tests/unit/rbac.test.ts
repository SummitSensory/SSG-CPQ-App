import { describe, it, expect } from 'vitest';
import { can, assertCan } from '../../src/authz/rbac.js';
import { Permission } from '../../src/authz/permissions.js';

describe('rbac matrix', () => {
  it('system admin has wildcard access', () => {
    expect(can('SYSTEM_ADMIN', Permission.PRODUCTS_ADMIN)).toBe(true);
    expect(can('SYSTEM_ADMIN', Permission.USERS_MANAGE)).toBe(true);
  });

  it('read-only user may read, but is denied every protected permission', () => {
    const readOnlyAllowed = new Set([
      Permission.CRM_READ, Permission.CATALOG_READ, Permission.RULES_READ,
      Permission.PRICING_READ, Permission.PROPOSAL_READ, Permission.ORDERS_READ,
    ]);
    for (const perm of Object.values(Permission)) {
      expect(can('READ_ONLY', perm)).toBe(readOnlyAllowed.has(perm));
    }
  });

  it('sales rep cannot see costs or margins', () => {
    expect(can('SALES_REP', Permission.COSTS_READ)).toBe(false);
    expect(can('SALES_REP', Permission.MARGINS_READ)).toBe(false);
  });

  it('sales manager may authorize discounts; installer may not', () => {
    expect(can('SALES_MANAGER', Permission.DISCOUNT_AUTHORIZE)).toBe(true);
    expect(can('INSTALLER', Permission.DISCOUNT_AUTHORIZE)).toBe(false);
  });

  it('only system admin manages integrations, products, users', () => {
    for (const role of ['EXECUTIVE', 'ACCOUNTING', 'SALES_MANAGER'] as const) {
      expect(can(role, Permission.INTEGRATIONS_MANAGE)).toBe(false);
      expect(can(role, Permission.PRODUCTS_ADMIN)).toBe(false);
      expect(can(role, Permission.USERS_MANAGE)).toBe(false);
    }
  });

  it('assertCan throws on denial', () => {
    expect(() => assertCan('DESIGNER', Permission.ACCOUNTING_WRITE)).toThrow();
  });
});

/** Fine-grained permissions guarding sensitive resources & actions. */
export const Permission = {
  CRM_READ: 'crm:read',
  CRM_WRITE: 'crm:write',
  CATALOG_READ: 'catalog:read',
  RULES_READ: 'rules:read',
  RULES_MANAGE: 'rules:manage',
  PRICING_READ: 'pricing:read',
  PRICING_OVERRIDE: 'pricing:override',
  PROPOSAL_READ: 'proposal:read',
  PROPOSAL_WRITE: 'proposal:write',
  PROPOSAL_REVIEW: 'proposal:review',
  PROPOSAL_RELEASE: 'proposal:release',
  COSTS_READ: 'costs:read',
  MARGINS_READ: 'margins:read',
  DISCOUNT_AUTHORIZE: 'discounts:authorize',
  ACCOUNTING_READ: 'accounting:read',
  ACCOUNTING_WRITE: 'accounting:write',
  INTEGRATIONS_MANAGE: 'integrations:manage',
  // QuickBooks: manage = connect/config/sync customers+items+view; transact =
  // authorize & create live financial documents (estimates/invoices).
  QBO_MANAGE: 'quickbooks:manage',
  QBO_TRANSACT: 'quickbooks:transact',
  // Accepted orders & operational handoff.
  ORDERS_READ: 'orders:read',
  ORDERS_MANAGE: 'orders:manage',
  HANDOFF_MANAGE: 'handoff:manage',
  PRODUCTS_ADMIN: 'products:admin',
  AUDIT_READ: 'audit:read',
  USERS_MANAGE: 'users:manage',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ROLES = [
  'SYSTEM_ADMIN','EXECUTIVE','SALES_REP','SALES_MANAGER','DESIGNER','ESTIMATOR',
  'OPERATIONS','ACCOUNTING','PROJECT_MANAGER','INSTALLER','READ_ONLY',
] as const;

export type Role = (typeof ROLES)[number];

const P = Permission;
const BASE = [P.CRM_READ, P.CRM_WRITE, P.CATALOG_READ, P.RULES_READ, P.PRICING_READ, P.PROPOSAL_READ, P.PROPOSAL_WRITE, P.ORDERS_READ];

/** Role -> granted permissions. SYSTEM_ADMIN holds the wildcard. */
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  SYSTEM_ADMIN: ['*'],
  EXECUTIVE: [...BASE, P.COSTS_READ, P.MARGINS_READ, P.ACCOUNTING_READ, P.AUDIT_READ, P.DISCOUNT_AUTHORIZE, P.PRICING_OVERRIDE, P.PROPOSAL_REVIEW, P.PROPOSAL_RELEASE, P.QBO_MANAGE, P.ORDERS_MANAGE, P.HANDOFF_MANAGE],
  SALES_MANAGER: [...BASE, P.COSTS_READ, P.MARGINS_READ, P.DISCOUNT_AUTHORIZE, P.PRICING_OVERRIDE, P.PROPOSAL_REVIEW, P.PROPOSAL_RELEASE, P.ORDERS_MANAGE],
  SALES_REP: [...BASE],
  DESIGNER: [...BASE, P.RULES_MANAGE],
  ESTIMATOR: [...BASE, P.COSTS_READ, P.MARGINS_READ],
  OPERATIONS: [...BASE, P.ORDERS_MANAGE, P.HANDOFF_MANAGE],
  PROJECT_MANAGER: [...BASE, P.COSTS_READ, P.ORDERS_MANAGE, P.HANDOFF_MANAGE],
  ACCOUNTING: [P.CRM_READ, P.CATALOG_READ, P.RULES_READ, P.PRICING_READ, P.PRICING_OVERRIDE, P.PROPOSAL_READ, P.ACCOUNTING_READ, P.ACCOUNTING_WRITE, P.COSTS_READ, P.MARGINS_READ, P.QBO_MANAGE, P.QBO_TRANSACT, P.ORDERS_READ],
  INSTALLER: [P.CRM_READ, P.CATALOG_READ, P.RULES_READ, P.PROPOSAL_READ, P.ORDERS_READ],
  READ_ONLY: [P.CRM_READ, P.CATALOG_READ, P.RULES_READ, P.PRICING_READ, P.PROPOSAL_READ, P.ORDERS_READ],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

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
  // Archive/restore a proposal. Reversible and destroys nothing, so it sits below
  // review: a rep holds it for their own proposals (ownership is checked in the
  // route), managers and accounting for anyone’s.
  PROPOSAL_ARCHIVE: 'proposal:archive',
  // Enter vendor freight costs onto a proposal that has already gone out, and apply
  // them to it. Narrow on purpose: it unlocks the freight fields of a frozen
  // version and nothing else (see proposals/freightTrueUp.ts, which refuses any
  // change that moves the subtotal, discount or tax). Held by the person who
  // manages vendor freight pricing, who is Operations here — she needs to price
  // freight on other people's jobs without being able to edit their proposals.
  FREIGHT_COST_WRITE: 'freight:cost-write',
  // Send an applied freight true-up to QuickBooks: append the freight to the
  // existing invoice, or raise the freight-only invoice when the original has
  // taken payment. Separate from QBO_TRANSACT — this changes what a customer owes
  // on a document they already hold, so it is granted deliberately rather than
  // inherited by anyone who can create a document.
  FREIGHT_INVOICE_PUSH: 'freight:invoice-push',
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
  'SYSTEM_ADMIN',
  'EXECUTIVE',
  'SALES_REP',
  'SALES_MANAGER',
  'DESIGNER',
  'ESTIMATOR',
  'OPERATIONS',
  'ACCOUNTING',
  'PROJECT_MANAGER',
  'INSTALLER',
  'READ_ONLY',
] as const;

export type Role = (typeof ROLES)[number];

const P = Permission;
const BASE = [
  P.CRM_READ,
  P.CRM_WRITE,
  P.CATALOG_READ,
  P.RULES_READ,
  P.PRICING_READ,
  P.PROPOSAL_READ,
  P.PROPOSAL_WRITE,
  P.ORDERS_READ,
];

/** Role -> granted permissions. SYSTEM_ADMIN holds the wildcard. */
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  SYSTEM_ADMIN: ['*'],
  EXECUTIVE: [
    ...BASE,
    P.COSTS_READ,
    P.MARGINS_READ,
    P.ACCOUNTING_READ,
    P.AUDIT_READ,
    P.DISCOUNT_AUTHORIZE,
    P.PRICING_OVERRIDE,
    P.PROPOSAL_REVIEW,
    P.PROPOSAL_RELEASE,
    P.PROPOSAL_ARCHIVE,
    P.FREIGHT_COST_WRITE,
    P.FREIGHT_INVOICE_PUSH,
    P.QBO_MANAGE,
    P.ORDERS_MANAGE,
    P.HANDOFF_MANAGE,
  ],
  SALES_MANAGER: [
    ...BASE,
    P.COSTS_READ,
    P.MARGINS_READ,
    P.DISCOUNT_AUTHORIZE,
    P.PRICING_OVERRIDE,
    P.PROPOSAL_REVIEW,
    P.PROPOSAL_RELEASE,
    P.PROPOSAL_ARCHIVE,
    P.FREIGHT_COST_WRITE,
    P.ORDERS_MANAGE,
  ],
  // A rep true-ups freight on their own jobs — they are usually the one holding the
  // vendor's email. Pushing the change to a live invoice is not theirs.
  SALES_REP: [...BASE, P.PROPOSAL_ARCHIVE, P.FREIGHT_COST_WRITE],
  DESIGNER: [...BASE, P.RULES_MANAGE],
  ESTIMATOR: [...BASE, P.COSTS_READ, P.MARGINS_READ, P.FREIGHT_COST_WRITE],
  // Operations owns vendor freight pricing: enters the quotes and puts them on the
  // invoice, without proposal review, release or margin visibility.
  OPERATIONS: [
    ...BASE,
    P.ORDERS_MANAGE,
    P.HANDOFF_MANAGE,
    P.FREIGHT_COST_WRITE,
    P.FREIGHT_INVOICE_PUSH,
  ],
  PROJECT_MANAGER: [...BASE, P.COSTS_READ, P.ORDERS_MANAGE, P.HANDOFF_MANAGE, P.FREIGHT_COST_WRITE],
  ACCOUNTING: [
    P.CRM_READ,
    P.CATALOG_READ,
    P.RULES_READ,
    P.PRICING_READ,
    P.PRICING_OVERRIDE,
    P.PROPOSAL_READ,
    P.ACCOUNTING_READ,
    P.ACCOUNTING_WRITE,
    P.COSTS_READ,
    P.MARGINS_READ,
    P.QBO_MANAGE,
    P.QBO_TRANSACT,
    P.ORDERS_READ,
    P.PROPOSAL_ARCHIVE,
    P.FREIGHT_COST_WRITE,
    P.FREIGHT_INVOICE_PUSH,
  ],
  INSTALLER: [P.CRM_READ, P.CATALOG_READ, P.RULES_READ, P.PROPOSAL_READ, P.ORDERS_READ],
  READ_ONLY: [
    P.CRM_READ,
    P.CATALOG_READ,
    P.RULES_READ,
    P.PRICING_READ,
    P.PROPOSAL_READ,
    P.ORDERS_READ,
  ],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

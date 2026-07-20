# Milestone 2 — Authentication & Role-Based Authorization

## Status
Scaffold authored on top of Milestone 1. **Not executed** in the authoring environment.
Run `pnpm check` and `pnpm test` on a real machine for actual results.
Apply the new migration with `pnpm db:migrate` (`0002_auth_authz`).

## Feature → file
| Feature | File |
|---|---|
| User accounts | `prisma/schema.prisma` (User), `src/routes/admin.ts` |
| Login / Logout / Refresh | `src/routes/auth.ts` |
| Session handling | `src/auth/session.ts` (Session table, hashed refresh tokens, rotation, revocation) |
| Password strategy | `src/auth/password.ts` (argon2id) |
| Role assignment | `PATCH /admin/users/:id/role` (`src/routes/admin.ts`) |
| Permission assignment | `src/authz/permissions.ts` (role→permission matrix) |
| Server-side authorization | `src/plugins/authz.ts` (`requirePermission`) |
| Protected routes / API | `src/routes/protected.ts`, admin guards |
| Admin user management | `src/routes/admin.ts` |
| Audit logging for permission changes | `src/lib/audit.ts`, AuditLog table |

## Roles (11)
SYSTEM_ADMIN, EXECUTIVE, SALES_REP, SALES_MANAGER, DESIGNER, ESTIMATOR, OPERATIONS, ACCOUNTING, PROJECT_MANAGER, INSTALLER, READ_ONLY.

## Protected resources → permission
| Resource | Permission | Roles granted |
|---|---|---|
| Internal costs | costs:read | SYSTEM_ADMIN, EXECUTIVE, SALES_MANAGER, ACCOUNTING, ESTIMATOR, PROJECT_MANAGER |
| Margins | margins:read | SYSTEM_ADMIN, EXECUTIVE, SALES_MANAGER, ACCOUNTING |
| Discount authority | discounts:authorize | SYSTEM_ADMIN, EXECUTIVE, SALES_MANAGER |
| Accounting actions | accounting:read / accounting:write | SYSTEM_ADMIN, ACCOUNTING (write); + EXECUTIVE (read) |
| Integration settings | integrations:manage | SYSTEM_ADMIN |
| Product administration | products:admin | SYSTEM_ADMIN |
| Audit records | audit:read | SYSTEM_ADMIN, EXECUTIVE |
| User management | users:manage | SYSTEM_ADMIN |

## Enforcement model
- Authorization is enforced **server-side** in `requirePermission` preHandlers, before any handler runs — not by hiding UI.
- Every sensitive route declares its required permission; unauthenticated → 401, authenticated-but-unpermitted → 403.
- Role/permission changes revoke the target's live sessions so new permissions apply immediately, and are written to the append-only AuditLog.
- Refresh tokens are stored only as SHA-256 hashes; sessions can be revoked and expire.

## Tests proving denial
- `tests/unit/rbac.test.ts` — matrix proofs (READ_ONLY denied all; SALES_REP no costs/margins; only SYSTEM_ADMIN manages integrations/products/users).
- `tests/integration/authz-routes.test.ts` — real Fastify requests: 401 unauthenticated, 403 for READ_ONLY/SALES_REP on every protected route, 200 for permitted roles, 401 on tampered tokens.

## Not tested / out of scope
- CPQ business logic (deferred) — protected endpoints are authorization stubs only.
- Login/refresh/logout and admin mutation happy-paths need a live DB; covered by design, exercised via `/auth` + `/admin` when running against Postgres (add DB-backed integration tests when a test DB is provisioned).
- Identity-provider (SSO/OIDC) strategy not implemented — password strategy chosen; IdP is a pluggable follow-up.
- Nothing was executed in this environment.

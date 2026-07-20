# Milestone 1 — Development Foundation

## Status
Scaffold authored. **Not executed** in the authoring environment (no terminal/DB there).
Run `pnpm check` and `pnpm test` on a real machine for actual results.

## Requirement → where it is satisfied
| Requirement | Implementation |
|---|---|
| Version-controlled repo | `.gitignore`, project layout, GitHub Actions |
| Application framework | Fastify (`src/app.ts`, `src/server.ts`) |
| TypeScript strict | `tsconfig.json` (all strict flags on) |
| Database connection | `src/lib/prisma.ts` + `assertDbConnection` |
| ORM config | Prisma (`prisma/schema.prisma`) |
| Migration framework | Prisma Migrate (`prisma/migrations/0001_init`) |
| Env validation | `src/config/env.ts` (Zod, fail-fast) |
| Secret handling | `.env` gitignored, `.env.example` only, log redaction |
| Auth foundation | `src/auth/password.ts`, `src/auth/tokens.ts` |
| Authz foundation | `src/authz/rbac.ts` |
| Logging | `src/lib/logger.ts` (Pino, redacted) |
| Error handling | `src/lib/errors.ts`, `src/plugins/error-handler.ts` |
| Unit tests | Vitest (`tests/unit`) |
| Integration tests | Vitest (`tests/integration`) |
| E2E tests | Playwright (`e2e`) |
| Code-quality checks | ESLint (`eslint.config.js`) |
| Formatting | Prettier (`.prettierrc.json`) |
| CI workflow | `.github/workflows/ci.yml` |
| Dev setup instructions | `README.md` |
| Staging deploy config | `Dockerfile`, `render.yaml` |

## Hard constraints
- No secrets in source — enforced by gitignore + env-only config.
- No disabled type checks — strict tsconfig; ESLint bans `any` and ts-comments.
- No placeholder auth in prod — no bypass paths exist; auth always verifies a real JWT.
- No unvalidated env — app throws at boot on invalid env.
- No float money — `src/lib/money.ts` uses `bigint`.
- No schema change without migration — Prisma Migrate; CI runs `migrate status`.

## Not tested / out of scope
- CPQ business logic (deferred).
- Domain models beyond `User`.
- E2E beyond `/health`.
- Performance and security scanning.

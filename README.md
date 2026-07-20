# Development Foundation (Milestone 1)

Version-controlled foundation for the application. **No CPQ business logic is implemented yet** — this milestone only stands up the framework, database, auth/authz foundation, observability, testing, and CI.

> **Nothing in this repo has been executed in the environment it was authored in.** Run the commands below on a machine with Node 22, pnpm, and Docker to produce real check/test results.

## Stack
| Concern | Choice |
|---|---|
| Runtime | Node 22 (`.nvmrc`) |
| Package manager | pnpm |
| Framework | Fastify |
| Language | TypeScript (strict) |
| ORM / DB | Prisma + PostgreSQL |
| Migrations | Prisma Migrate |
| Env validation | Zod (fails fast at boot) |
| Auth foundation | Argon2 password hashing + JWT access/refresh |
| Authz foundation | Role-based (RBAC) policy helper |
| Logging | Pino (structured, redacts secrets) |
| Money | Integer minor units via `bigint` — never floats |
| Unit / integration tests | Vitest |
| E2E tests | Playwright |
| Lint / format | ESLint (flat config) + Prettier |
| CI | GitHub Actions |
| Staging | Docker image + `render.yaml` blueprint |

## Requirements this scaffold enforces
- **No secrets in source** — everything comes from env; `.env` is gitignored; only `.env.example` is committed.
- **No disabled type checks** — `strict: true`, no `// @ts-ignore`, ESLint bans `any` and ts-suppressions.
- **No placeholder auth in production paths** — dev-only shortcuts are guarded by `NODE_ENV !== 'production'` and throw otherwise.
- **No unvalidated env** — `src/config/env.ts` parses `process.env` with Zod and the app refuses to boot on failure.
- **No float money** — `src/lib/money.ts` uses `bigint` minor units.
- **No schema change without a migration** — Prisma Migrate; CI checks migrations are in sync.

## First-time setup (development)
```bash
# 1. Node version
nvm use                       # reads .nvmrc (Node 22)

# 2. Install deps
corepack enable
pnpm install

# 3. Environment
cp .env.example .env          # then fill in real values

# 4. Start Postgres
docker compose up -d db

# 5. Apply migrations + generate client
pnpm db:migrate
pnpm db:generate

# 6. Run the API
pnpm dev                      # http://localhost:3000/health
```

## Run all checks (do this for real results)
```bash
pnpm typecheck        # tsc --noEmit, strict
pnpm lint             # eslint
pnpm format:check     # prettier --check
pnpm db:migrate:status  # migrations in sync with schema
pnpm check            # runs all of the above
```

## Run all tests
```bash
pnpm test:unit        # vitest run  (tests/unit)
pnpm test:integration # vitest run  (tests/integration, needs DB)
pnpm test:e2e         # playwright test  (needs running server)
pnpm test             # unit + integration
```

## What is NOT tested yet
- Any CPQ business logic (out of scope for Milestone 1).
- E2E covers only the `/health` endpoint (no product flows exist yet).
- Integration tests cover env validation, auth token round-trip, and DB connectivity — not domain models (none exist).
- No load/performance or security-scan suite yet.

## Files created in this milestone
See the tree in `docs/MILESTONE-1.md`.

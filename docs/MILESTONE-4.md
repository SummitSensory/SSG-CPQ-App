# Milestone 4 — monday.com Two-Way Sync + Vercel Deploy

## Status
Scaffold authored. **Not executed** here. Apply migration `0004_monday_sync`; run `pnpm check` and `pnpm test`.

## Integration shape (confirmed)
- **Two-way sync** between local Opportunities and a monday **deal-tracking** board.
- **Inbound trigger: monday webhooks** (`POST /integrations/monday/webhook`).
- **Outbound**: on opportunity create/update the app pushes to monday.
- **Auth**: monday API token + webhook signing secret, both **env-only** (no secrets in source).

## Files
| Concern | File |
|---|---|
| GraphQL client | `src/integrations/monday/client.ts` |
| Field/stage mapping | `src/integrations/monday/mapping.ts` |
| Sync engine (loop-safe) | `src/integrations/monday/sync.ts` |
| Webhook signature verify | `src/integrations/monday/webhook.ts` |
| Routes (status + webhook) | `src/routes/integrations.ts` |
| Sync state + log | `prisma/schema.prisma`, migration `0004_monday_sync` |
| Vercel deploy | `vercel.json`, `api/index.ts` |
| Env (DIRECT_URL + monday secrets) | `src/config/env.ts` |

## Loop & idempotency safety
- Every synced opportunity stores a `mondaySyncHash`. Outbound push is skipped when the hash is unchanged; after applying an inbound change we recompute the hash so our own push does not echo it back.
- Inbound events are deduped by a unique `eventId` in `IntegrationSyncLog` — redelivered webhooks return `duplicate`.
- All sync attempts (ok/error) are logged append-only.

## Vercel / Postgres
- **Vercel Postgres (Neon)** with a **pooled** `DATABASE_URL` (app) + **direct** `DIRECT_URL` (migrations) — see `schema.prisma` datasource.
- Serverless entry `api/index.ts`; `vercel.json` routes all traffic to it. The Docker/`render.yaml` path remains for non-Vercel hosting.
- monday secrets are **required in production** (env validation fails the boot otherwise).

## Tests
- Unit: `monday-mapping` (stage↔status round-trip, integer→decimal budget, loop-guard hash).
- Integration: `monday-webhook` (challenge handshake, unsigned→401, valid signature accepted).

## Not tested / out of scope
- Live monday API calls (require a real token + board) — client is unit-mockable; wire a contract test against a sandbox board when credentials exist.
- Product pricing (still deferred).
- Column ids in `mapping.ts` are defaults — confirm against the actual monday board and override before go-live.
- DB-backed inbound apply path needs a test DB (covered by design).

# Milestone 10 — monday.com Integration (full)

## Status
Scaffold authored, extending Milestone 4. **Not executed** here. Apply migration `0010_external_links`; run `pnpm check` and `pnpm test`. **Use a sandbox board first** — see the manual test procedure in `docs/MONDAY-INTEGRATION.md`.

## Deliverables
- **Mapping + source-of-truth documentation:** `docs/MONDAY-INTEGRATION.md` (entity map, per-field source of truth, conflict handling, reliability controls, 10-step sandbox manual test procedure).

## Files
| Concern | File |
|---|---|
| External IDs / links | `src/integrations/monday/links.ts`, `ExternalLink` model (migration `0010`) |
| Source of truth + approved conflict rules | `src/integrations/monday/conflict.ts` |
| Rate-limit-aware client | `src/integrations/monday/client.ts` |
| Sync engine (idempotent, conflict-safe, retry) | `src/integrations/monday/sync.ts` |
| Reconciliation report | `src/integrations/monday/reconcile.ts` |
| Routes (status, links, logs, reconcile, retry, webhook) | `src/routes/integrations.ts` |

## Requirement compliance
- **Store external IDs** — `ExternalLink(provider, entity, entityId, externalId, boardId)`.
- **Prevent duplicates** — unique `(provider, entity, entityId)` and `(provider, externalId)`; create is skipped when a link exists.
- **Idempotency** — inbound deduped by unique `eventId`; outbound guarded by the link + `lastSyncedHash` (no write when unchanged).
- **Rate limits** — client retries HTTP 429 (honors `Retry-After`) and monday complexity/limit codes with capped, jittered exponential backoff.
- **Log attempts** — every attempt → `IntegrationSyncLog` (ok/error/conflict/received).
- **Manual retry** — `POST /integrations/monday/retry/:logId`.
- **Show sync status** — `GET /integrations/monday/status`, `/links`, `/logs`.
- **Validate webhooks** — monday signed-JWT verification; unsigned → 401; challenge handshake echoed.
- **Reconciliation reporting** — `GET /integrations/monday/reconcile` (drift, errored links, recent failures).
- **Never overwrite authoritative CPQ values** — `decideInbound` refuses inbound writes to any CPQ-authoritative field; only approved conflict rules (stage, project status) permit inbound; refusals logged as `conflict`.
- **Document source of truth per field** — table in `docs/MONDAY-INTEGRATION.md` + machine-readable `FIELD_SOURCE_OF_TRUTH`.

## Tests
- `tests/unit/monday-conflict.test.ts` — CPQ fields refuse inbound; stage & project status allowed; unknown refused; source-of-truth lookups.
- `tests/unit/monday-client.test.ts` — 429 retry-then-succeed (mock fetch), complexity-code retry, GraphQL error no-retry, backoff growth/cap/Retry-After.
- `tests/integration/monday-integration.test.ts` — webhook challenge, unsigned 401, signature verify, manage-permission gating on reconcile.
- `tests/integration/monday-webhook.test.ts` (from M4) still applies.
- **Manual procedure:** `docs/MONDAY-INTEGRATION.md` §5 (sandbox board, 10 steps).

## Not tested / out of scope
- Live monday API calls (need a real sandbox token + board) — client is exercised via mock fetch; run the manual procedure against the sandbox.
- DB-backed link upsert/dedup and the reconciliation query need a test DB — pure conflict/rate-limit logic is fully unit-covered.
- Entities beyond Opportunity (Organization, Contact, Proposal, Order, Project) are mapped and documented; their push/pull adapters reuse `links.ts` + `conflict.ts` and are wired per board as those boards are provisioned.

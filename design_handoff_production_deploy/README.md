# Handoff: Production Deployment — Summit Sensory Gym CPQ

## Purpose
Instruction spec for **Claude Code** to prepare and execute the approved production deployment of the
Summit Sensory Gym CPQ application (Milestones 1–17 complete: build, security/quality review, UAT).
Execute against the real infrastructure and repo. This is an operational runbook, not a design bundle.

## GATE 0 — Do not deploy while release blockers remain
Before any production action, confirm and record:
- Pre-release `RELEASE_BLOCKERS.md` = **CLEARED** (no open Critical/High).
- UAT `RELEASE_RECOMMENDATION.md` = **GO** (no open Critical/High defects; exit criteria met).
If either is not satisfied, **stop** and report BLOCKED. Do not proceed, and do not describe the system
as production-ready.

---

## Part A — Prepare
### 1. Production environment
Provision the prod deployment (Vercel prod project or equivalent) separate from UAT/preview. Pin
runtime versions to match tested build. Document the environment topology.

### 2. Environment-variable validation
Add/confirm a startup env validator (fail-fast) that asserts presence + format of every required var:
`DATABASE_URL`, `DIRECT_URL`, auth/session secrets, `QBO_*` (client id/secret, environment=production,
token encryption key), `MONDAY_API_KEY`, file-storage creds, monitoring/error-tracking DSNs, base URL.
App refuses to boot if any are missing/malformed. Record the validated list (names only, never values).

### 3. Production database
Provision managed Postgres (prod tier), private networking, least-privilege app credentials,
connection pooling. Confirm `DIRECT_URL` used for migrations only.

### 4. Database backup
Enable automated backups + point-in-time recovery on the prod DB; set retention per policy. Take a
**pre-deploy manual backup snapshot** and record its id/time.

### 5. Migration plan
Apply Prisma migrations `0001…latest` to prod via `DIRECT_URL` in a maintenance window. Dry-run against
a restored copy of the pre-deploy snapshot first. Record migration checksums + the exact command +
before/after schema version.

### 6. Rollback plan
Document and stage: (a) revert to previous deployment build (immutable prior release), (b) DB rollback
via restore of the pre-deploy snapshot / PITR to the pre-migration timestamp, (c) decision criteria +
who authorizes, (d) integration considerations (QBO/monday external records created during the window).
Rollback steps must be copy-pasteable and tested on the restored copy from step 5.

### 7. Domain and SSL
Configure prod domain, DNS, managed TLS cert; force HTTPS + HSTS; verify cert chain + auto-renewal.

### 8. Authentication configuration
Set prod auth: session/cookie flags (HttpOnly, Secure, SameSite), token lifetimes, password policy,
prod OAuth callback URLs, admin bootstrap account with a rotated credential. No test/UAT users in prod.

### 9. File storage
Provision prod object storage (import sources, proposal PDFs, handoff docs): private buckets, signed
URLs, size/type limits, backup/retention, no public listing, path-traversal-safe keys.

### 10. Background jobs
Configure prod workers/schedulers (integration retries, reconciliation, backups). Confirm concurrency,
idempotency, dead-letter handling, and that a failed job alerts rather than silently drops.

### 11–14. Observability
- **Monitoring** — uptime/health checks on app + DB + integrations; latency + error-rate dashboards.
- **Error tracking** — prod DSN wired; source maps; release tagging.
- **Logging** — structured, no secrets/PII/tokens; audit logs separated; retention set.
- **Alerts** — on-call routing for: app down, elevated 5xx, DB connection saturation, backup failure,
  integration failure spike, auth anomaly. Define thresholds + who is paged.

### 15. Integration credentials
Install **production** QBO app credentials (production company authorization) and the production
monday.com API key/board mapping in the prod secret store. Encrypt stored OAuth tokens with the prod
key. Never commit secrets; record only names + rotation dates.

---

## Part B — Execute deployment
1. Re-confirm GATE 0.
2. Take pre-deploy DB snapshot (step 4) — record id.
3. Enter maintenance window.
4. Deploy build; run env validator (must pass).
5. Apply migrations via `DIRECT_URL`; confirm schema version.
6. Warm health checks; then run the pre-success verification (Part C) BEFORE announcing.

---

## Part C — Verification (all 10 must pass before declaring success)
Run in order; record evidence for each in the release report. Any failure → stop, assess rollback.

1. **Production smoke tests** — app loads, login works, create customer → opportunity → proposal →
   PDF path reachable, dashboards load; health endpoints green.
2. **Role permissions** — for each role (Rep, Manager, Ops, PM, Installer, Accounting, Exec), confirm
   in-scope allowed and out-of-scope returns 403 (cost/margin/deposit hidden without financial perm;
   reps see own records only). Test via API, not just UI.
3. **Database backups** — confirm automated backup + PITR enabled AND that the pre-deploy snapshot
   exists and is listed.
4. **Monday.com synchronization** — using a controlled test record on the production board (or a
   dedicated non-billable test project), confirm project/item create + id storage + event logging;
   clean up the test artifact.
5. **QuickBooks connection — WITHOUT unauthorized live transactions** — verify OAuth connection +
   token refresh + company info read (read-only). Do **not** create live estimates/invoices as part of
   verification. Confirm write capability only via a dry-run/permission check or a clearly-labeled
   reversible test that is immediately voided with product-owner authorization — default is read-only
   verification only.
6. **Proposal PDF generation** — generate a PDF from a real version; confirm it matches the version's
   snapshot exactly (lines, discounts, tax, totals, terms) and renders correctly.
7. **Audit logging** — perform an auditable action (e.g. order verify) and confirm the append-only
   `OrderEvent`/audit entry is written with actor + timestamp and cannot be mutated.
8. **Monitoring and alerts** — trigger a synthetic alert (e.g. failing health check or test error) and
   confirm it fires to the on-call channel; confirm dashboards populate.
9. **Rollback instructions** — confirm the documented rollback (build revert + DB restore/PITR) is
   complete, staged, and was rehearsed on the restored copy; include exact commands in the report.
10. **Production-release report** — produce `PRODUCTION_RELEASE_REPORT.md` (below).

### Financial-action safeguards (verify present, not by firing live money movements)
- Money as integer cents; financial ops transactional + idempotent (one order per proposal; QBO/monday
  writes idempotent via stored external ids; deposit invoiced vs collected distinct).
- Financial writes gated by permission + require explicit user action (no auto live invoicing on
  deploy). Confirm no background job creates live financial records without authorization.

---

## Deliverables (docs)
- `PRODUCTION_RELEASE_REPORT.md` — environment, deployed build/commit, migration version, GATE 0
  evidence, all 10 verification results with evidence links, backup snapshot id, rollback commands,
  outstanding risks, and the final GO-live statement (only after all 10 pass).
- `ROLLBACK_INSTRUCTIONS.md` — standalone, copy-pasteable revert + restore steps with decision criteria.
- `RELEASE_NOTES.md` — user-facing summary of what shipped this release.
- `ADMIN_GUIDE.md` — env vars, integration setup + credential rotation, backup/restore, job management,
  monitoring/alerts, user/role administration, incident response.
- `USER_GUIDE.md` — role-based how-to for the core flows (customer → opportunity → configure → price →
  discount → proposal → revise → approve → accept → handoff → reports).
- `SUPPORT_PROCESS.md` — how users report issues, triage + severity, escalation to Claude Code (one
  bounded fix at a time), SLAs, and on-call rotation.

## Success rule
Declare success and mark the app live **only** after GATE 0 held and all 10 verification steps passed
with recorded evidence. If any step fails, do not declare success — remediate or roll back, and report
status honestly.

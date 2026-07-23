# Handoff: Reporting & Dashboard Milestone

## Purpose of this package
This is an **implementation spec for Claude Code**, not a UI design bundle. It defines the next
milestone on the existing proposal/CRM codebase (Milestones 1–12: auth/roles, catalog, proposals
with versions + price snapshots, QBO integration, monday.com integration, and the accepted-order /
operational-handoff lock). Hand this folder to Claude Code and implement it against the repo's
established stack (Prisma + Postgres, TypeScript route layer, existing authz middleware, existing QBO
and monday clients, existing `OrderEvent` audit).

If any assumption below conflicts with the real repo, prefer the repo's conventions and note the
deviation.

---

## Goal
Provide **role-appropriate reporting and dashboards** across the whole lifecycle — opportunities →
proposals → accepted orders → integrations → margin/finance. Every metric is precisely defined in a
**metric dictionary**, protected against double counting, filterable by date, exportable where
authorized, drillable to supporting records, stamped with data freshness, and unambiguous about
which money stage (estimated / proposed / accepted / invoiced / collected) it represents.

---

## Design principles (apply to every report)
1. **Single source of truth per metric.** Each metric is computed by exactly one function in
   `src/reporting/metrics/`, referenced by both the API and the tests. No inline SQL duplicated
   across routes.
2. **Money-stage discipline.** Never mix stages in one number. Every monetary field is tagged with a
   stage: `ESTIMATED | PROPOSED | ACCEPTED | INVOICED | COLLECTED`. Reports that show more than one
   stage present them as separate columns/series, never summed together.
3. **No double counting.** Rules below (see "Double-counting guards"). Enforced in code and asserted
   in tests.
4. **Grain is explicit.** Each metric declares its grain (per opportunity / per proposal / per latest
   accepted version / per order / per line item). Aggregations only combine same-grain rows.
5. **Everything is drillable.** Every summary number returns (or can fetch) the ids of the supporting
   records that compose it.
6. **Freshness is visible.** Every response carries `dataAsOf` (query time) plus per-source freshness
   for QBO and monday (`lastSyncedAt`, `syncStatus`).

---

## Role → report access matrix
Reuse existing role/permission map. Add permissions:
`reports:read` (base dashboards, no cost/margin), `reports:financials` (cost, margin, discount,
deposit, collected amounts), `reports:export`.

| Report group | reports:read | reports:financials | notes |
|---|---|---|---|
| Opportunities, pipeline, proposal value (proposed), win rate, age, expiration, follow-up, product mix, customer type, sales rep, project stage, accepted orders, integration sync/failures, freight/install estimates, approval turnaround, revision frequency | ✅ | ✅ | non-cost operational metrics |
| Discounts, gross margin, margin exceptions, deposits, invoiced amount, collected amount | ❌ | ✅ | cost/margin restricted |

Grants (align with existing role names): Sales Rep → `reports:read` (own records + team where
allowed); Sales Manager / Ops / PM → `reports:read`; Accounting / Exec / Sales Manager →
`reports:financials`; export permitted for Manager / Ops / Accounting / Exec. Sales Reps see their
own opportunities/proposals by default; managers+ see all. Enforce row-level scoping (ownerId) in the
query layer, not just the route.

---

## Metric dictionary
Implement as a typed registry `src/reporting/dictionary.ts` — one entry per metric, and generate
`docs/METRIC-DICTIONARY.md` from it so definition and code never drift. Each entry:
`{ key, label, group, grain, stage?, permission, definition, formula, doubleCountGuard, drilldown }`.

Definitions (authoritative):

- **opportunities.count** — grain: opportunity. Count of Opportunity rows in an `open` state within
  the date filter (by `createdAt`). Excludes archived/deleted.
- **pipeline.byStage** — grain: proposal. Count + PROPOSED value of proposals grouped by
  `projectStage`, latest version only. A proposal appears in exactly one stage.
- **proposal.value.proposed** — stage: PROPOSED. Sum of latest-version proposal totals for proposals
  in an active (non-lost, non-accepted) state. Uses the price snapshot of the latest version.
- **winRate** — accepted proposals ÷ decided proposals over the date range, decided = accepted + lost
  (exclude still-open and expired-not-decided). Report numerator/denominator alongside the ratio.
- **proposal.age** — for open proposals: `now − latestVersion.sentAt` (or `createdAt` if never sent).
  Report median + buckets (0–7 / 8–14 / 15–30 / 30+ days).
- **proposal.expiration** — proposals with `expiresAt` within the window; buckets: expired, ≤7d, ≤30d.
  Grain: proposal, latest version.
- **followUp.status** — distribution of follow-up state (due / overdue / scheduled / none) for open
  proposals. Overdue = `nextFollowUpAt < now`.
- **discounts** — stage: PROPOSED (and a separate ACCEPTED cut). Discount = `listTotal −
  proposedTotal` per latest version; report total discount, avg discount %, count of discounted
  proposals. `reports:financials`.
- **grossMargin** — stage-aware. `margin = revenue − cost` where revenue and cost both come from the
  SAME snapshot; report at PROPOSED (latest version) and ACCEPTED (accepted order snapshot) as
  separate series. Margin % = margin ÷ revenue. `reports:financials`.
- **marginExceptions** — count + list of proposals/orders whose margin % is below the configured
  threshold (per policy table). Links to each record. `reports:financials`.
- **productMix** — grain: line item. Revenue/quantity share by catalog category, from latest version
  (PROPOSED) and accepted orders (ACCEPTED) as separate views. Guard against counting a line twice
  across versions (latest-only).
- **customerType** — pipeline/value grouped by customer type (e.g. new vs existing, segment). Grain:
  proposal, latest version.
- **salesRep** — per-rep pipeline, win rate, proposed value, accepted value. Row-level scoped.
- **projectStage** — count + value by stage (same as pipeline.byStage, exposed per-record for board).
- **acceptedOrders** — stage: ACCEPTED. Count + accepted value from AcceptedOrder.contentSnapshot
  totals. One row per AcceptedOrder (never per proposal version).
- **deposits** — stage split: deposit INVOICED (qboInvoiceId set, invoiced amount) vs COLLECTED
  (marked paid). Never sum invoiced + collected. `reports:financials`.
- **qboSync** — count of orders/invoices by sync status; last successful sync time; error count.
- **mondaySync** — count of orders with monday project by status; last sync time; error count.
- **freightEstimates** — stage: ESTIMATED. Sum/avg of shipping requirement estimates from handoff
  records. Clearly labeled ESTIMATED, never rolled into revenue.
- **installEstimates** — stage: ESTIMATED. Sum/avg of installation requirement estimates. ESTIMATED.
- **integrationFailures** — count + list of `*_FAILED` OrderEvents (QBO/monday) in range, grouped by
  type, with links to the order and the retry state.
- **approvalTurnaround** — median/avg time from proposal `acceptedAt` (or approval requested) to
  `CustomerApproval.approvedAt` / order lock. Grain: accepted order.
- **revisionFrequency** — avg number of ProposalVersions per proposal (and distribution), within
  range. Grain: proposal.

---

## Double-counting guards (enforce + test)
- **Latest-version-only** for all proposal-level metrics: join to the max(versionNumber) per proposal;
  never aggregate across historical versions.
- **One order per proposal**: accepted-order metrics key on AcceptedOrder.id; a proposal with an
  accepted order is excluded from open-pipeline metrics.
- **Money stages are disjoint columns**: a single query never adds fields of different stage tags.
- **Deposit vs total**: deposit amounts are reported in the deposit metric only, not added into
  accepted-order revenue (they are a portion of it).
- **Line-item dedupe**: product mix counts each accepted/latest line exactly once (composite key
  proposalVersionId+lineId).
- **Estimates excluded from revenue**: freight/install ESTIMATED amounts never enter margin/revenue.

---

## API (`src/routes/reports.ts`)
Reuse authz middleware; enforce `reports:read` / `reports:financials` / `reports:export` per matrix
and row-level owner scoping.

- `GET /reports/dictionary` — `reports:read`. Returns the metric dictionary (definitions the UI shows
  on hover / info).
- `GET /reports/:metricKey` — permission from the dictionary entry. Query params: `from`, `to`
  (date filter, default last 90d), `groupBy?`, plus metric-specific filters. Returns
  `{ metric, params, dataAsOf, freshness, rows, totals, drilldownAvailable }`.
- `GET /reports/:metricKey/drilldown` — same permission. Returns the supporting record ids/rows that
  compose a given summary cell (accepts the same filters + a group key).
- `GET /reports/:metricKey/export?format=csv` — requires `reports:export` AND the metric's own
  permission. Streams CSV of the drilldown rows. Reject with 403 if unauthorized.
- `GET /reports/freshness` — `reports:read`. QBO/monday `lastSyncedAt` + status, DB `dataAsOf`.

All date filters use a single inclusive-start / exclusive-end convention (`[from, to)`); document it
in the dictionary and apply consistently.

---

## Data freshness
- `dataAsOf` = query timestamp on every response.
- QBO/monday freshness read from the existing sync bookkeeping (last successful sync row / event).
  Surface `lastSyncedAt`, `syncStatus` (`ok | stale | failing`), and `ageMinutes`. Mark `stale` past
  a configurable threshold.

---

## Tests (key calculations must be covered)
- `tests/unit/metrics-winrate.test.ts` — numerator/denominator, excludes open/expired-undecided.
- `tests/unit/metrics-margin.test.ts` — revenue & cost from same snapshot; PROPOSED vs ACCEPTED
  series separate; margin % math; threshold → exceptions.
- `tests/unit/metrics-double-count.test.ts` — multiple versions/orders on one proposal counted once;
  deposit not added to revenue; estimates excluded from revenue; product-mix line dedupe.
- `tests/unit/metrics-stages.test.ts` — ESTIMATED/PROPOSED/ACCEPTED/INVOICED/COLLECTED never summed
  together; deposit invoiced vs collected kept distinct.
- `tests/integration/reports-authz.test.ts` — cost/margin/deposit metrics 403 without
  `reports:financials`; export 403 without `reports:export`; row-level scoping (rep sees own only).
- `tests/integration/reports-datefilter.test.ts` — `[from,to)` boundary correctness; freshness fields
  present.
- `tests/integration/reports-drilldown.test.ts` — drilldown row ids reconcile exactly to the summary
  total for each metric.

## Acceptance criteria
- Every metric above is defined in the dictionary and computed by a single shared function.
- Cost/margin/discount/deposit reports are inaccessible without `reports:financials`; export gated by
  `reports:export`.
- No metric double counts (tests prove it); estimated/proposed/accepted/invoiced/collected are always
  distinguishable.
- Date filters, drilldown links, and per-source freshness work on every report.
- `docs/METRIC-DICTIONARY.md` is generated from the registry.
- `pnpm check && pnpm test` pass.

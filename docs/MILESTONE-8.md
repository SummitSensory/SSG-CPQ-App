# Milestone 8 — Proposal Builder

## Status
Scaffold authored on top of Milestones 1–7. **Not executed** here (no terminal/DB). Apply migration `0008_proposals`; run `pnpm check` and `pnpm test`. A preview/PDF Design Component (`Proposal Preview.dc.html`) renders live and exports to PDF via the print-ready `doc-page` shell.

## Model (`prisma/schema.prisma`, migration `0008_proposals`)
Proposal (number, org, title, currentVersion) → ProposalVersion (status, JSON sections + items, price/rule snapshot links, expiration, frozen flag) → ProposalStatusEvent (append-only status history).

## Content coverage → sections
Customer info, facility info, project goals, executive summary, recommended configuration, product descriptions, product images, design renderings, included/optional/alternate items (with quantities), pricing table, discounts, freight, installation, travel, taxes, fees, payment schedule, assumptions, customer responsibilities, exclusions, estimated timeline, warranty, expiration date, terms & conditions, signature fields — all modeled as modular `SECTION_TYPES` (`src/proposals/sections.ts`).

## Features → implementation
| Feature | Where |
|---|---|
| Modular sections | `src/proposals/sections.ts` (SECTION_TYPES, ProposalSection) |
| Reordering | `reorderSections` + `PATCH …/versions/:id` (orderedSectionIds) |
| Conditional sections | `resolveVisibleSections` (condition predicate) |
| Preview | `POST /proposals/versions/:id/preview` + `Proposal Preview.dc.html` |
| PDF generation | `Proposal Preview.dc.html` on `doc-page` (print-ready, no rebuild) |
| Proposal numbering | `formatProposalNumber` + sequential allocator (`nextNumber`) |
| Statuses (draft/review/released/accepted/rejected/expired) | `src/proposals/status.ts` + status routes |
| Version history | ProposalVersion + `createNewVersion` (clones current) |
| Comparison between versions | `src/proposals/compare.ts` + `GET /proposals/:id/compare` |
| Pricing snapshot preservation | `priceSnapshotId` / `ruleSnapshotId` on each version (links Milestones 6–7 snapshots) |
| Audit history | `recordAudit` on every mutation + ProposalStatusEvent |

## Immutability (key requirement)
A version is frozen the moment it is **RELEASED** (`frozen=true`, `releasedAt/By` stamped). `updateVersionContent` refuses edits to any frozen/terminal version with 409. The **only** way to change a released proposal is `createNewVersion`, which clones content into a new editable DRAFT and bumps `currentVersion`. Released/accepted/rejected/expired versions therefore remain immutable historical records.

## Permissions
`proposal:read` (broad), `proposal:write` (create/edit/new version/submit review), `proposal:review` (return-to-draft, accept, reject, expire), `proposal:release` (release). SALES_REP writes but cannot release; SALES_MANAGER/EXECUTIVE review + release.

## Tests
- `proposals-sections` — order, disabled, conditional show/hide, reorder + renumber, append missing, drop unknown.
- `proposals-status` — legal/illegal transitions, freeze-on-release, frozen-status set, number formatting.
- `proposals-compare` — added/removed/changed items, section text change, meta (price snapshot, expiration), identical-version no-diff.
- `proposals-authz` — unauthenticated release 401, writer cannot release 403, releaser passes gate, READ_ONLY create 403.

## Tested vs. not
- **Tested (by construction; run `pnpm test` for real results):** layout/section logic, comparison, status/version integrity, permissions.
- **PDF output** — verified structurally via the `doc-page` preview; exact paginated PDF must be checked with the Save-as-PDF flow on `Proposal Preview.dc.html`.
- **Calculations** — the proposal consumes pricing snapshots from Milestone 7 (whose historical regression remains blocked pending fixtures); the proposal layer does not recompute money.
- **Not tested here:** DB-backed service paths (numbering allocator, clone-on-new-version, frozen-edit refusal against live rows) need a test DB — logic is covered by the pure-function unit tests; nothing was executed in this environment.

# Milestone 6 — Product-Configuration Rules Engine

## Status
Scaffold authored. **Not executed** here (no terminal/DB). Apply migration `0006_rules_engine`; run `pnpm check` and `pnpm test`.

## Core principle (per instruction)
**The engine makes no unapproved safety or engineering assumptions.** It contains
zero hard-coded thresholds — every dimension, clearance, quantity, and structural
expectation comes from admin-authored rule data. When a required fact is absent
(room size, ceiling height, structural rating, freight detail), the engine emits
`REQUEST_INFORMATION` rather than assuming a pass or a fail. A rule missing its
threshold param throws a configuration error instead of guessing.

## Rule types (18) → all supported
REQUIRES, EXCLUDES, COMPATIBLE_WITH, INCOMPATIBLE_WITH, MIN_QUANTITY, MAX_QUANTITY,
MIN_ROOM_DIMENSIONS, MIN_CEILING_HEIGHT, CLEARANCE, STRUCTURAL, INSTALLATION,
FREIGHT, AUTO_INCLUDE_COMPONENT, AUTO_CALCULATED_COMPONENT, SUGGESTED_ACCESSORY,
SUGGESTED_UPGRADE, APPROVAL_REQUIRED, MISSING_INFORMATION.

## Outcomes (7)
ALLOW, BLOCK, WARN, REQUIRE_APPROVAL, AUTO_ADD, RECOMMEND, REQUEST_INFORMATION.

## Files
| Concern | File |
|---|---|
| Types / outcomes | `src/rules/types.ts` |
| Pure evaluator | `src/rules/engine.ts` |
| Cycle prevention | `src/rules/graph.ts` |
| Definition validation | `src/rules/validation.ts` |
| Persistence + versioning + snapshots | `src/rules/service.ts` |
| Routes (evaluate + admin) | `src/routes/rules.ts` |
| Data model | `prisma/schema.prisma`, migration `0006_rules_engine` |

## Requirement compliance
- **Structured, auditable data** — `Rule` + immutable `RuleVersion`; every change audited via `recordAudit`.
- **Not hard-coded in UI** — evaluation is a server engine over DB rules; UI only calls `/rules/evaluate`.
- **Preserve rule version used by a proposal** — `evaluate({persist:true})` writes an immutable `RuleEvaluationSnapshot` capturing `rulesUsed` (ruleId+version), findings, and `engineVersion`.
- **Explain why a rule fired** — every `Finding` carries a human message (template-interpolated) plus the triggering `facts`.
- **Prevent circular dependencies** — `assertNoCycles` runs on activation over the REQUIRES / AUTO_INCLUDE graph; activation is rejected with 409 on a cycle.
- **Prevent duplicate automatic additions** — auto-adds are deduped by product (max quantity, merged sources) and never added if already in the configuration.
- **Administrator controls for approved changes** — `rules:manage` gates create/version/activate/retire; activation records `approvedById`.
- **Protect historical configurations** — versions and evaluation snapshots are immutable; retiring a rule never deletes prior versions.
- **No floating-point** — `AUTO_CALCULATED_COMPONENT` uses integer ratio + `Math.ceil`.

## Tests (comprehensive)
- `tests/unit/rules-engine.test.ts` — one test per rule type + edge cases: missing-info requests, custom message interpolation, dedupe across rules, no-double-add, misconfig throws, whole-config rules, `rulesUsed` capture.
- `tests/unit/rules-graph.test.ts` — direct/transitive cycles, acyclic pass, edge building, activation rejection.
- `tests/unit/rules-validation.test.ts` — per-type params, illegal outcome, negative thresholds, approvalRole requirement, malformed key.
- `tests/integration/rules-authz.test.ts` — non-manager create → 403, unauthenticated evaluate → 401, manager passes authz.

## Not tested / out of scope
- DB-backed service paths (`getActiveRuleDefs`, activation cycle-check against live data, snapshot persistence) need a test DB — logic is covered by the pure-engine and graph tests.
- No pricing (deferred).
- The engine consumes rules; authoring correct clinical/engineering thresholds is an administrative task, intentionally left to authorized rule managers.

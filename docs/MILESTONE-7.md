# Milestone 7 — Pricing Engine

## ⚠ COMPLETION NOT CLAIMED
The milestone's final requirement is: *do not report completion unless historical
totals are reproduced or every discrepancy is documented.* That is **not met**:
1. **No anonymized approved historical proposals were provided**, so no reproduction
   has been demonstrated. (Fabricated fixtures would make any claim meaningless.)
2. **Tests were not executed in the authoring environment** (no terminal/DB).

To reach completion: add fixtures under `tests/regression/fixtures/` (see that
README), run `pnpm test`, and either match every total or document each
discrepancy in `docs/PRICING-DISCREPANCIES.md`.

## What was built
Decimal-safe pricing engine + centralized domain service. Apply migration
`0007_pricing`.

| Concern | File |
|---|---|
| Decimal-safe math + rounding modes | `src/pricing/decimal.ts` |
| Pricing engine (pure) | `src/pricing/engine.ts` |
| Domain service (price resolution, snapshots, overrides) | `src/pricing/service.ts` |
| Routes | `src/routes/pricing.ts` |
| Data model | `prisma/schema.prisma`, migration `0007_pricing` |

## Supported inputs
Price lists (effective/expiration dates), product/variant/bundle/component prices,
customer-specific & promotional prices, quantity adjustments, internal costs,
line & order discounts (reason + authority), margins & thresholds, freight,
installation, travel, per diem, mileage, taxes, tax exemptions, credit-card &
other fees, deposit/progress/final payment schedule, price snapshots, and a link
field for rule-version snapshots (from Milestone 6).

## Requirement compliance
- **Decimal-safe arithmetic** — money is integer minor units (bigint); rates are integer basis points; no floats. (`decimal.ts`)
- **Rounding defined & tested at every level** — `RoundingPolicy` per level (lineDiscount, orderDiscount, tax, fee, ccFee, payment); tested in `pricing-decimal.test.ts`. Payment `final` absorbs the residual so splits sum exactly.
- **Centralized** — all formulas live in `src/pricing`; routes/UI only call it.
- **Preserve historical pricing** — immutable `PriceSnapshot`; price lists carry effective/expiration dates.
- **Explain each amount** — every line and total carries an explanation; `explanations[]` narrates order-level math.
- **Log overrides / require auth + reason** — `logOverride` writes `PriceOverrideLog` + audit; route gated by `pricing:override`; reason mandatory.
- **Approval on threshold breach** — discount-authority and min-margin breaches emit `REQUIRE_APPROVAL`.
- **Never silently zero** — missing money is `null` → `MISSING_VALUE` finding + `incomplete: true`; parser throws on malformed input.
- **Mark unconfirmed freight/installation** — `FeeInput.confirmed`; unconfirmed surfaces `UNCONFIRMED` findings and `unconfirmed` flags.
- **Cost/margin visibility** — route strips cost/margin unless the role holds `costs:read`/`margins:read`.

## Tests
- `pricing-decimal.test.ts` — every rounding mode + bps math + parse/format + malformed-input throw.
- `pricing-engine.test.ts` — missing-value (never 0), unconfirmed freight/install, discount-authority & margin-threshold approvals, tax + exemption ref, credit-card fee, payment residual, config errors, per-line explanations.
- `tests/regression/historical.test.ts` — harness for anonymized approved proposals (skips, visibly, until fixtures exist).

## Not done / blocked
- Historical reproduction (blocked — see top).
- DB-backed price resolution paths need a test DB.
- Proposal-document assembly and `Proposal expiration` UI belong to the proposal milestone; the engine supports expiration via snapshot + price-list dates.

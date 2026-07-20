# Historical-proposal regression fixtures

This directory is **intentionally empty of real data**. To satisfy the milestone
requirement — *"do not report completion unless historical totals are reproduced
or every discrepancy is documented"* — you must add anonymized, approved
historical proposals here as fixtures, then run `pnpm test`.

## Fixture format
One JSON file per proposal, `tests/regression/fixtures/<name>.json`:

```json
{
  "name": "proposal-2025-0142 (anonymized)",
  "input": {
    "currency": "USD",
    "lines": [
      { "ref": "L1", "productId": "P1", "quantity": 2, "unitPrice": "1250n", "unitCost": "800n", "priceSource": "price-list" }
    ],
    "tax": { "rateBps": 825, "exempt": false },
    "payment": { "depositBps": 5000, "progressBps": 3000, "finalBps": 2000 }
  },
  "expected": { "grandTotal": "270750", "tax": "20625", "goodsNet": "250000" }
}
```

Notes:
- Money in `input` is written as a minor-unit string with a trailing `n` (e.g. `"1250n"` = $12.50); the harness revives these to bigint.
- `expected` values are plain minor-unit strings taken from the APPROVED proposal total.
- Anonymize all customer/PII fields before committing. Use synthetic ids.

## Documenting discrepancies
If a fixture does not reproduce, DO NOT delete it. Record the delta, the suspected
cause (rounding level, missing fee, rule version, price-list effective date), and
the resolution in `docs/PRICING-DISCREPANCIES.md`. Completion requires either an
exact match or a documented, explained discrepancy for every proposal.

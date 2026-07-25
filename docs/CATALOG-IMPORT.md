# Catalog Import — Product Workbook v3

Source: `uploads/Summit Product Workbook v3-5854e249.xlsx` (updated 2026-07-25).
Normalized to `prisma/seed-catalog.json`; validated by `src/catalog/workbook-import.ts`;
applied by `prisma/seed-catalog.ts`.

```
pnpm db:seed:catalog --dry-run   # validate + report, no writes
pnpm db:seed:catalog             # apply (idempotent, upsert by natural key)
```

## What came in

| | count |
|---|---|
| Product lines | 4 (Adventure Series, Summit Soar, Summit Flex, Therapy Equipment) |
| Manufacturers | 9 |
| Products | 341 |
| Tier headers | 18 |
| Tier product placements | 334 |
| Product notes | 6 |
| Cost rows | 339 |
| Sourcing rows | 328 |

Tier tree as imported:

```
ADVENTURE SERIES FRAME
DUAL TROLLEY SYSTEM
THERAPEUTIC ACTIVITY & ADVENTURE COMPONENTS
  Summit Adventure Slide System
  Climbing Wall & Safety Accessories
  Ladder - Safety Accessories
  Therapeutic Swing & Sensory Equipment Package
  Essential Carabiners & Connectors
  Complete Zip Line Kit
  Frame Mounted Therapy Rack
ADVENTURE MAT SYSTEM
  Adventure Mat System
  Advanced Therapy Mat Accessories
SUMMIT FOUNDATION SYSTEM
HARDWARE
  Hardware
  Quick Shift
```

## Fixes applied during normalization

1. **`PRODUCT` is a marker, not a tier.** The workbook writes `PRODUCT` in the
   tier column that holds the placement. The importer strips it, so a SKU under
   `Components > Carabiners > PRODUCT` lands at tier 3 under Carabiners rather
   than a phantom tier-4 node.
2. **Missing intermediate headers are created.** `HARDWARE > Quick Shift` was
   referenced by two SKUs but never declared on its own row; the importer
   creates the header.
3. **Money and weight are integers.** Prices/costs → minor units (cents),
   weight lbs → whole ounces. No floats reach the database.
4. **Costs are append-only** and effective-dated. Re-importing an unchanged
   cost is a no-op; a changed cost on the same date updates in place; a new
   date inserts a new row so history survives.
5. **Notes are replace-on-import** — the workbook is authoritative for them.
6. **SKU matching is case-insensitive.** The Costs tab carried `k-5000` where
   Products has `K-5000`; the importer resolves it to the canonical SKU rather
   than dropping the row.

## Open items for you

- **Two mat notes stay on `SSUSP72`** — confirmed, no change. `ProductNote`
  attaches to products only; no `SectionNote` model needed.
- **`H-1000`** is emitted by `adventureSeries.ts` but is still not on the
  Products tab. The importer adds it as a stub (`Hardware`, tier 2 under
  `HARDWARE`, default qty 1). It has **no description, price, cost, or
  manufacturer**. Add it to the workbook to retire the stub.
- **`B08SMN18WG`** (Safety Net - 6.5' X 9.8', $134.99) is the only remaining
  SKU with no cost row.
- **12 SKUs have no manufacturer** and so won't appear on the BOM:
  `B08SMN18WG`, `A-2216`, `B01MUEBGVK`, `B0018L8RJG`, `WS8203`, `150045`,
  `A-2349`, `B07V3J9S2R`, `B07TSDMPNQ`, `SSG-SA-CFM`, `SSG-SA-CWM`,
  `SSG-SA-CLIMB-WALL-MOUNT-KIT-ONLY`. The Costs tab now reaches row 342 but
  Product Sourcing still stops at row 330 — drag that one down too.
- **All 339 cost rows have no effective date** — defaulted to 2026-07-25. Fine
  as a baseline; supply real dates when you want true cost history.
- **11 SKUs are not placed in the tier structure**: `P-2018`, `P-2025`,
  `CUST-LOGO`, `CUSTOM`, `6820H-LAN`, `B004NTO8T8`, `B01MUEBGVK`,
  `B0018L8RJG`, `B07V3J9S2R`, `B07TSDMPNQ`,
  `SSG-SA-CLIMB-WALL-MOUNT-KIT-ONLY`. They import and are quotable, they just
  won't show when browsing the catalog tree — expected for option/variant SKUs,
  worth a look for the cargo nets and slide variants.

## Re-importing after a workbook revision

The `.xlsx` → `seed-catalog.json` step is a conversion, not part of the app
(no spreadsheet dependency ships in the runtime). Send the revised workbook and
the JSON is regenerated; the seed script is safe to re-run.

# Catalog Import — Product Tree (revised)

Source: `uploads/summit-product-tree-1-Revised-336bbf52.xlsx`, Tree sheet
(updated 2026-07-29). Supersedes `Summit Product Workbook v3-5854e249.xlsx` for
tier structure and sort order.
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
| Products | 322 |
| Tier headers | 19 |
| Tier product placements | 322 |
| Product notes | 6 |
| Cost rows | 320 |
| Sourcing rows | 309 |

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
  Hardware Product List
  Quick Shift
SUMMIT SOAR SERIES
SUMMIT SOAR MATS & ACCESSORIES
```

## Sort order bands

`sortOrder` is one global sequence, unique across the whole tree. Headers and
products share the sequence, so a header always sorts above its own children.

| Band | Owns |
|---|---|
| 20000–39999 | Adventure Series and everything non-Soar (incl. HARDWARE at 30010+) |
| 40000–49999 | Summit Soar |

Numbering steps by 10 in document order so a row can be inserted between two
neighbours without renumbering. Ties fall back to alphabetical, which is why
duplicates are treated as an error, not a cosmetic issue.

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
- **`H-1000` has no unit price by design** — it is a roll-up whose value is the
  sum of the hardware item numbers beneath it, so it must never print its own
  price on a proposal. It sits at tier 2 under `HARDWARE` (sort 30020).
- **`B08SMN18WG`** (Safety Net - 6.5' X 9.8', $134.99) is the only remaining
  SKU with no cost row.
- **12 SKUs have no manufacturer** and so won't appear on the BOM:
  `B08SMN18WG`, `A-2216`, `B01MUEBGVK`, `B0018L8RJG`, `WS8203`, `150045`,
  `A-2349`, `B07V3J9S2R`, `B07TSDMPNQ`, `SSG-SA-CFM`, `SSG-SA-CWM`,
  `SSG-SA-CLIMB-WALL-MOUNT-KIT-ONLY`. The Costs tab now reaches row 342 but
  Product Sourcing still stops at row 330 — drag that one down too.
- **All 339 cost rows have no effective date** — defaulted to 2026-07-25. Fine
  as a baseline; supply real dates when you want true cost history.
- **Retired in this revision**: `CUSTOM`, `CUST-LOGO` (placeholders, never
  quotable as-is), `9RGRX` (name was a fragment of another row's description) and
  `9TACP` (never placed in the tree). Removed from products, costs, sourcing and
  the tree.
- **Every product now has a tier row.** `9TACP` was retired with the placeholders,
  so the `Unfiled — Therapy Equipment` bucket is gone.
- **Two `parentSlug` repairs.** `Hardware Product List` was its own parent, which
  put itself and its 37 fasteners in a reference cycle, and `Quick Shift` pointed
  at it rather than at `HARDWARE`. Both now parent to
  `adventure-series--hardware`. Guard when editing the tree: a tier's slug is an
  identity, so renaming a header must never change its slug or any `parentSlug`
  pointing at it.
- **All 37 fasteners have a zero weight.** Prices and costs are complete, so the
  H-1000 roll-up totals correctly, but it contributes 0 lb to the shipping weight
  and understates freight. The proposal's zero-weight counter flags this.
- **`Therapeutic Swing & Sensory Equipment Package` holds 184 of 322
  placements.** Accepted for now; it will print as one very long block and
  should be subdivided before this structure is treated as final.

## Re-importing after a workbook revision

The `.xlsx` → `seed-catalog.json` step is a conversion, not part of the app
(no spreadsheet dependency ships in the runtime). Send the revised workbook and
the JSON is regenerated; the seed script is safe to re-run.

## What the Hardware Kit line prints

The H-1000 line's price, cost and weight are always the sum of the 37 fastener
rules. What it *says* is a business number:
`hardwareRollupDetail` (Administration → Formulas → Business numbers → "List
every fastener on the Hardware Kit line").

| Value | The line reads |
|---|---|
| 0 (default) | `All mounting hardware for this structure — 214 pieces across 22 part numbers.` |
| 1 | `4× Washer 1/2 Flat (6820H-LB) · 12× Hex Bolt… (6820H-LA) · …` |

The full breakdown is always available in the logic trace
(`POST /proposals/adventure-series/trace`), so switching to 0 hides it from the
customer without losing the cross-reference.

Fasteners the configurator asks for **by name** — `6820H-LDD`, `6820H-LAC-G`,
`6820H-LP`, `B0C4Y8XSNB`, `SSG-SA-SWIVEL-EYE` — always print as their own lines
and are excluded from the roll-up, so they are never double-counted.

## Bill of Materials — per-vendor sections (build 41)

Migration `0029_bom_vendor_sections`. The order-level BOM header columns on
`AcceptedOrder` are unchanged and now act as the DEFAULTS a new section inherits.

| Table | Holds |
|---|---|
| `BomVendorSection` | one header per (order, vendor): dates, notes, ship-to, sort order, confirm/unlock state |
| `BomQuestionTemplate` | reusable questions, per vendor or all vendors (admin) |
| `BomVendorAnswer` | those questions + answers, snapshotted onto the order |
| `BomSend` | append-only audit of every BOM emailed to a vendor |
| `PowderColorBrand` | the managed brand list — seeded with Cardinal and Prismatic |
| `FinanceFactor` | Ryan Capital payment factor per term |

New columns: `ProcurementLine.powderBrandId` + `powderColorCode`, `Sku.productUrl`,
`Sku.requiresPowderColor`, and `Manufacturer.bomEmail*` (per-vendor email
defaults + preferred attachment format).

The migration backfills one section per (order, vendor) already present in the
procurement lines, so existing orders render unchanged.

### Rules worth knowing

- **Sections are derived, never invented.** A vendor with procurement lines gets a
  section on next page load; nothing creates a vendor.
- **`SUBMITTED` is the lock.** Every writer passes through one `assertEditable`
  check, so field edits, questions and colour application are all frozen together.
  Unlocking requires a reason and is written to the order timeline.
- **An unsubmitted section shows today's date** without writing it. The date is
  only persisted when the operator confirms or types one.
- **Confirm is gated.** A required question with no answer, or a part flagged
  `requiresPowderColor` with no colour, blocks submission.
- **Colours are two-step: pick the brand, type the code.** The brand comes from the
  managed list (Cardinal, Prismatic) because that is where the spelling drift was;
  the code is free text because the brands' catalogues change faster than we could
  maintain a copy. Both are stored, plus the printed string `"<brand> <code>"`, so
  renaming a brand can never rewrite a sheet a vendor already has.
  `requiresPowderColor` is off by default — most parts are not powder coated.
- Different parts on one frame can carry different codes; that is the normal case,
  not an exception. `POST /orders/:id/bom/apply-color` paints one brand+code onto a
  named set of part numbers, and never overwrites a colour chosen by hand unless
  `overwrite` is set.
- `GET /powder-colors` returns the brands plus `recentCodes` — codes already used
  on this deployment, offered as a convenience so a repeat colour can be picked
  instead of retyped. It is never a validation list.

### Editing a submitted section is refused, including its lines

`patchProcurementLine` now looks up the line's vendor section and refuses the write
when it is SUBMITTED. Without that, the grey-out in the UI would be cosmetic — a
stale tab could still PATCH a frozen line.

## Build 42 — BOM sections in the UI, financing, server-rendered PDFs

Migration `0030_requirement_task_updated_by` adds `updatedById` to
`HandoffRequirement` and `HandoffTask`. Nullable on purpose: rows that predate it
genuinely have no recorded author, and inventing one would be worse than "—".

### Order page

- **QuickBooks now sits above the Bill of Materials.**
- **One card per vendor**, gold-edged while draft, green once submitted, greyed and
  disabled when locked. Confirm freezes it; unlocking needs a reason and lands on
  the order timeline.
- Requirements and internal tasks show **who last changed the row and when**, under
  the status.
- Sections carry ↑/↓ ordering, which is the order they print and export in.
- A part with a `productUrl` shows a **Buy ↗** link.

### Documents

`src/handoff/bomDocuments.ts` renders the BOM as self-contained HTML and as
SpreadsheetML. The same HTML feeds the browser print dialog, the PDF download and
the email attachment, so the three cannot drift apart. PDF export tries the server
renderer first and silently falls back to the browser print path when it is not
installed.

### Financing

Everything is computed from the proposal's price snapshot — there is no document to
create. `src/proposals/financing.ts` holds the maths, `financingDocument.ts` the
sheet. Administration → Financing edits the payment factors and the two tax
settings; the settings reuse the `FormulaSetting` table under a `finance.` prefix
rather than adding a second settings table.

**Payment factors, not interest rates.** A lessor publishes a factor per term and
the payment is `amount x factor`. Deriving that from an APR would mean guessing at
their compounding and fees and printing a payment they would not honour.

### Vendor email defaults

Per-manufacturer To/Cc/subject/body/format, with `{{vendor}}`, `{{order}}`,
`{{job}}` and `{{submittedOn}}` tokens. The send dialog pre-fills from these and
stays editable. Every send writes a `BomSend` row — sender, timestamp, recipients,
subject, format, and success or failure — before and after the provider call, so a
failed send is recorded rather than lost.

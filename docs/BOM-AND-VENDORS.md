# Manufacturers, bundles & the Bill of Materials — build 19

What changed, why, and what to do after deploying.

## 1. “Sourcing” is gone; the section is the Bill of Materials

“Sourcing” was a per-line status meaning *someone has actually placed this order*.
It printed on the vendor PDF because that PDF was a straight dump of the on-screen
table. It is now the **Status** column (Pending / Ordered), and the whole area is
named consistently:

| Was | Now |
| --- | --- |
| Nav: Orders & Handoff | Nav: **Orders & Bill of Materials** |
| Section: Procurement | Section: **Bill of Materials** |
| PDF title: Procurement — *Vendor* | **Bill of Materials** — *Vendor* |
| Column: Sourcing | **Status** |
| Buttons: Export all | **Export BOM** |
| Seeded task: “Verify procurement list & source items” | “Verify Bill of Materials & order parts” (new orders only) |

The database table is still `ProcurementLine` — renaming it would break every
existing order for no operational gain.

## 2. The Bill of Materials document

`GET /orders/:id/bom?vendor=<name|*>&includeZeroQty=true|false` assembles it;
`src/handoff/bom.ts` is the only place the document is defined, so the Excel and
PDF exports can never disagree.

It prints:

* **Summit Sensory Gym branding** — logo, name, 6150 S Geneva Court, Englewood CO
  80111, 720-440-7850, Orders@SummitSensory.com.
* **Ship from (vendor)** — from the manufacturer record.
* **Ship to** — the customer's site or Summit's dock, chosen per order.
* **Customer of record** — organisation, primary contact, title, email, phone and
  shipping address, from CRM.
* **Header fields** — job, submission date, delivery type, powder coat brand,
  estimated shipment quote, total steel weight, total weight, vendor terms.
* **Lines** — Line # (part number), description, qty, powder colour, extended
  weight, cost each, total cost, vendor notes.
* **Footer** — prepared by (the signed-in user), created date/time, order number.

Prices are **our unit cost** — this is a purchasing document, not a quote. Cost
and unit weight are snapshotted onto each line at lock time (and backfilled once
for orders locked before this build), so reprinting a BOM a year later reproduces
the same document.

**Total steel weight** sums only lines whose vendor is flagged *steel fabricator*
in the Manufacturers tab, which is what excludes hardware and crating. The
migration sets that flag on **Goldberg Brothers**; flag any other fabricator
yourself.

**Zero-quantity parts** are off by default. Tick *Include zero-quantity parts*
before exporting to get the full order-form style — the rest of that vendor's
active catalogue at qty 0. It only applies to a single-vendor export.

**Powder colour** is per line, and there is a one-shot *Apply to steel lines* box
in the header for the normal case of one colour per job.

## 3. Manufacturers (Catalog → Manufacturers)

A real vendor record: name, primary contact (name, title, email, phone),
secondary contact, full address, website, our account number, payment terms,
default lead time, third-party flag, steel-fabricator flag, active flag, notes.

* Renaming a manufacturer also rewrites the vendor name stored on flat SKU rows,
  so parts never silently lose their vendor.
* A vendor referenced by any part or order line **cannot** be deleted — deactivate
  it. Deactivating leaves every past order and BOM untouched.

## 4. Bundles (Catalog → Bundles)

There were no bundles before this build. The `*-BUNDLE` items in the catalog are
flat priced SKUs with the word in their description — one price, no contents.

A bundle now is a catalog product of kind `BUNDLE` whose contents are
`ProductRelation` rows. It carries **no price of its own**: price, cost and weight
are always the live sum of its components × quantities.

On a proposal, adding a bundle from the picker inserts:

1. one priced line at the rolled-up price, and
2. its components beneath it as zero-rate sub-lines carrying the real part
   numbers, cost and weight.

That is what makes the BOM, the cost of goods and the freight weight see the
actual parts instead of a wrapper. One level only — bundles cannot nest.

## 5. Product tree: rename, reorder, export, import

* **Categories & tiers** — rename inline, change tier, show/hide, reorder with the
  arrows, delete (only when empty). Renaming never moves a product.
* **Reorder list** — the default product order used by the proposal picker and the
  tier listings (`Product.sortOrder`).
* **Export tree / Import tree** — a workbook with one sheet per level:
  `Categories`, `Products`, `Bundles`. Export then re-import round-trips exactly.

Import rules (both the tree import and the catalog CSV import):

* Matched on **slug** (categories) and **part number** (products).
* **Only the columns present in the file are written.** A sheet of `part,unitCost`
  reprices and touches nothing else.
* **Nothing is ever deleted.** Parts the file leaves out are listed in a review
  step; you choose *leave as they are* or *deactivate*.
* Everything is previewed first — press Import a second time to commit.

## 6. Endpoints added

```
GET    /manufacturers                     list + part counts
GET    /manufacturers/:id                 one vendor + its part list
GET    /manufacturers/:id/usage           what a delete would affect
POST   /manufacturers                     create
PATCH  /manufacturers/:id                 update (renames carry to SKU rows)
DELETE /manufacturers/:id                 refused when referenced

GET    /catalog/bundles                   bundles + components + rollups
POST   /catalog/bundles                   create the wrapper
PUT    /catalog/bundles/:id/components    replace contents
DELETE /catalog/bundles/:id               remove wrapper only

PATCH  /catalog/categories/:id            rename / retier / show-hide / reparent
DELETE /catalog/categories/:id            only when empty
POST   /catalog/categories/reorder        explicit order
POST   /catalog/products/reorder          default product list order
GET    /catalog/tree/export               all rows, one array per sheet
POST   /catalog/tree/import               dry-run review, then commit

GET    /orders/:id/bom                    assembled BOM document
PATCH  /orders/:id/bom                    BOM header fields
PATCH  /orders/procurement/:lineId        powder colour, notes, PO #, status
POST   /orders/:id/bom/powder-color       one colour across steel lines
```

## 7. After deploying

1. Run the migration (`0022_bom_manufacturers`) — additive only, no backfill
   needed, safe on a live database.
2. Open **Catalog → Manufacturers** and fill in the address + POC for the vendors
   you actually raise POs with. Confirm the steel-fabricator flag.
3. Open a locked order once. Part number, vendor, cost and unit weight backfill
   from the catalog on open; manual entries are never overwritten.
4. Set the BOM header on that order (job, ship-to, delivery type, powder brand),
   then export one vendor to PDF and compare it against your Goldberg example.

Anything still blank on a line means that part is not in the catalog under that
exact name or part number — send the list and it can be reconciled in bulk.

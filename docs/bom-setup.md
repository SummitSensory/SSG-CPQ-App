# BOM setup — order, headings and vendor routing

How the manufacturing team controls the way a Bill of Materials reads. Nothing here
changes a price, an existing proposal, or an accepted order's totals. The one setting
that reaches proposals is a processing supplier's Repackaging Service Fee, and only on
proposal lines added after it is set. It counts as the part's cost, never its price
(see below).

## Where things are

| Task                                                                | Where                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Preset order, heading, standing note, vendor routing for many parts | **Catalog → BOM setup** (tick parts, use the green bar)                                                           |
| Same, in Excel                                                      | **Catalog → BOM setup → Download sheet / Upload sheet**                                                           |
| Why is this part under Hardware?                                    | **Catalog → BOM setup → Hardware check**, or the grey "Under Hardware · …" line under each part on an order's BOM |
| Rearrange one order's sheet                                         | Order → Bill of Materials → vendor section → **Arrange lines**                                                    |
| Kits (one proposal line → several parts)                            | **Catalog → BOM build** (unchanged)                                                                               |
| Rename the BOM's column headings                                    | **Catalog → BOM setup → Column headings**                                                                         |

## Order on the sheet

Highest priority first:

1. **This order's arrangement** — set with _Arrange lines_.
2. **The part's sequence** — `bomSequence` in BOM setup (lowest first). Number in tens
   (10, 20, 30…) so a part can be slotted in later; "Sequence — number in the order
   shown" in the bulk bar does that for you.
3. **The proposal's order** — for parts with no sequence, after all sequenced parts.

## Headings

_Automatic_ puts H-1000 kit fasteners and parts with a hardware rule under
**Hardware** and everything else in the main list. Set a part to **Main list** to keep
it out of Hardware even though a rule says otherwise, or to any heading you name
("Crating", "Bag 3").

## Buying from one vendor, processing through another

Example: a part is bought on Amazon (its **Procurement Supplier**) and delivered to
Goldberg Brothers (the **Processing Service Supplier**). Goldberg repackages it and
ships it to the customer with the structure, sometimes for a packaging charge.

The columns on BOM setup:

| Column                          | What it is                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Procurement Supplier**        | Who we buy the part from. Read from the catalog: the SKU's vendor, else the product's primary sourcing, the same rule the BOM uses. Change it in the catalog.        |
| **Unit Purchase Cost**          | What we pay the procurement supplier for one unit (catalog cost). When the part is processed, the cost a new proposal line will take is shown under it.              |
| **Processing** (checkbox)       | Tick it when the part goes to a processing service supplier. The next three columns open once it is ticked.                                                          |
| **Processing Service Supplier** | The vendor who receives, repackages and ships it.                                                                                                                    |
| **Repackaging SKU**             | The processing supplier's own SKU for the service. It prints as the part # on their sheet. Leave it blank to use the Manufacturers → Parts mapping, then our part #. |
| **Repackaging Service Fee**     | What they charge, **per unit** or **per order** (once for the order, whatever the quantity). Blank or $0 means no charge; the line is then a receiving note.         |

What prints once a part is ticked and has a supplier:

- **Amazon's sheet**: the part at its Unit Purchase Cost. This is the purchase.
- **Goldberg's sheet**: one line for the part's whole quantity on the order, under the
  Repackaging SKU, at the Repackaging Service Fee. It is noted "Repackaging service —
  supplied by Summit from Amazon; bill the service fee, not the part". A per-order fee is
  charged once (`$50.00 per order`, total $50), not multiplied by the quantity.

**The part never falls off either sheet.**

- At lock, the processing line is added for every processing part, including one that
  comes out of a kit.
- Changing the quantity of the part's purchase line, adding the part by hand, or taking it
  off moves the processing line with it. If the processing supplier's sheet is already
  submitted, the line can't change, and the person making the change is told so.
- _Apply BOM build rules_ adds any processing line that is missing and tops up one that
  covers fewer units than are bought.

**Cost of the order.** The order's cost is purchase cost plus the fee, so cost of goods
and margin include the fee on new proposals:

- A per-unit fee is added to the part's cost on the proposal line.
- A per-order fee is carried on the line once.
- The customer's price is never changed.
- As with all catalog costs, a proposal keeps the figure it had when the part was added.

These settings apply to orders **locked from now on**. On an order already locked, the
_Apply BOM build rules_ button on its Bill of Materials picks them up.

**What happened to "Ships through" and "Also on vendor".** They are now this one setting.

- "Ships through" (free issue) _moved_ the part to the receiving vendor at $0, so it fell
  off the sheet of the vendor it was bought from.
- Migration 0120 turned every ship-through part into a processing part at a $0 fee.
- A part that already had a different "also on vendor" kept that vendor. BOM setup flags
  it ("Old ships through … was not converted") so someone can decide and dismiss it. The
  _Old "ships through" to review_ filter lists them.
- Orders locked under free issue keep printing as they did.

Turning a part's **Processing** box off keeps its supplier, SKU and fee on file (greyed
out). Nothing prints and no fee is added until it's ticked again.

## "Use this for all future orders too?"

After a correction on an order's BOM line, a bar asks whether to keep it:

- **Note** → saved as the part's standing BOM note, copied onto the line on every
  future order.
- **Cost on a processing line** → saved as the part's Repackaging Service Fee, with its
  per unit / per order basis. New proposals add it to the part's cost.
- **Cost on an ordinary line** → saved as the part's catalog cost. Offered to catalog
  admins only, because it changes every future proposal's margin.
- **Arrange lines** asks the same question with two buttons: _This order only_ /
  _This order and all future orders_.

Orders already locked are never changed by these; each keeps its own sheet.

## Who can change it

Anyone with BOM permission (Operations, Project Manager, Executive, System Admin).
Saving a part's own catalog cost from an order needs a catalog admin.

## Column headings

**Catalog → BOM setup → Column headings** renames the columns of every Bill of
Materials: the order screen, the PDF, Excel and CSV, and the emailed copy. Clear a box
to go back to the default. "Cost Each" now reads **Vendor Cost** by default. The processing supplier's charge in
BOM setup reads **Repackaging Service Fee** (formerly "Their charge", then "Vendor Cost"). A vendor's own colour
heading on its profile (Resilite's "Vinyl color") still wins over the colour column's
default. The headings are only words: the colour check finds its columns by key, so
renaming them changes nothing else.

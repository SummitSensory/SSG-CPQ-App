# BOM setup — order, headings and vendor routing

How the manufacturing team controls the way a Bill of Materials reads. Everything here
is BOM configuration: it never changes a proposal, a price, or an accepted order's
totals.

## Where things are

| Task                                                                | Where                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Preset order, heading, standing note, vendor routing for many parts | **Catalog → BOM setup** (tick parts, use the green bar)                                                           |
| Same, in Excel                                                      | **Catalog → BOM setup → Download sheet / Upload sheet**                                                           |
| Why is this part under Hardware?                                    | **Catalog → BOM setup → Hardware check**, or the grey "Under Hardware · …" line under each part on an order's BOM |
| Rearrange one order's sheet                                         | Order → Bill of Materials → vendor section → **Arrange lines**                                                    |
| Kits (one proposal line → several parts)                            | **Catalog → BOM build** (unchanged)                                                                               |

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

## Buying from one vendor, shipping through another

Example: a part is bought on Amazon, delivered to Goldberg Brothers, and Goldberg ships
it to the customer with the structure.

| Setting                                                      | What prints                                                                                                                                                                                              | Cost on the order                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Ships through (free issue)** = Goldberg                    | The part moves to **Goldberg's** sheet at **$0**, marked "Supplied by Summit at no charge (from Amazon) — do not invoice". It is not on Amazon's sheet; purchasing buys it with the part's **Buy** link. | The real Amazon cost stays on the line — cost of goods is unchanged. |
| **Also on vendor** = Goldberg, **their charge** = $X (or $0) | The part stays on **Amazon's** sheet at the real cost (the purchase), **and** gets a second line on **Goldberg's** sheet at $X — their handling, coating, or $0 as a receiving note.                     | Amazon cost + Goldberg's $X.                                         |

Use **Ships through** when Goldberg simply receives it. Use **Also on vendor** when
Goldberg charges for it, or when you want Amazon's own sheet as a buy list.

These settings apply to orders **locked from now on**. On an order already locked, the
_Apply BOM build rules_ button on its Bill of Materials picks them up.

## "Use this for all future orders too?"

After a correction on an order's BOM line, a bar asks whether to keep it:

- **Note** → saved as the part's standing BOM note, copied onto the line on every
  future order.
- **Cost on a second-vendor line** → saved as that vendor's charge.
- **Cost on an ordinary line** → saved as the part's catalog cost. Offered to catalog
  admins only, because it changes every future proposal's margin.
- **Arrange lines** asks the same question with two buttons: _This order only_ /
  _This order and all future orders_.

Orders already locked are never changed by these; each keeps its own sheet.

## Who can change it

Anyone with BOM permission (Operations, Project Manager, Executive, System Admin).
Saving a part's own catalog cost from an order needs a catalog admin.

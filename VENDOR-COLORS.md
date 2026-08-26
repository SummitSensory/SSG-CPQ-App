# Vendor colours — install notes

Colour selection for any vendor and any finish, maintained per vendor under
**Administration → Manufacturers → Colours**. The Goldberg Brothers powder-coat
chart (Administration → Formulas → Paint colour) is untouched and keeps its own
brand + code path.

## Model

- **VendorColorPalette** — one chart per vendor per finish (`VINYL`,
  `POWDER_COAT`, `PAINT`, `OTHER`). Resilite's vinyl list is one palette.
- **VendorColor** — a named colour on that chart, with the vendor's own code, an
  optional upcharge and an admin-set order. Discontinued colours deactivate
  rather than disappear.
- **ProductColorSpec** — which product takes how many colours (1–7) from which
  chart, whether the choice is required to quote, an optional per-slot
  fabrication upcharge, and optional slot names. Keyed on a catalog product _or_
  a part number, never both (`CHECK` constraint).
- **ProcurementLine.colorPicks** (JSONB) — the colours chosen for a BOM line, in
  slot order, with the name and vendor code copied alongside the id so a historic
  sheet still reads the same after a colour is renamed.

## Files

| File                                                         | What it is                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma/schema.vendor-colors.prisma`                         | models to append to `schema.prisma`, plus the two lines to add to `Manufacturer` and `ProcurementLine` (listed at the bottom of that file) |
| `prisma/migrations/0056_vendor_color_palettes/migration.sql` | the migration                                                                                                                              |
| `src/vendorColors/service.ts`                                | spec resolution, selection validation, upcharge maths, document text                                                                       |
| `src/routes/vendorColors.ts`                                 | the endpoints                                                                                                                              |
| `src/app.ts`                                                 | registers the routes (2 added lines)                                                                                                       |
| `public/vendor-colors.js`                                    | the admin screen                                                                                                                           |
| `public/app.js`                                              | adds the **Colours** button to the manufacturer row (3 added blocks)                                                                       |
| `public/index.html`                                          | loads `vendor-colors.js`, bumps `app.js?v=55`                                                                                              |

Order: copy the files, append the schema models, `prisma migrate deploy`,
`prisma generate`, deploy.

## Endpoints

    GET    /manufacturers/:id/color-palettes      charts, colours, product rules
    GET    /manufacturers/:id/color-targets       this vendor's products and parts
    POST   /manufacturers/:id/color-palettes
    PATCH  /color-palettes/:id
    DELETE /color-palettes/:id                    refused while products use it
    POST   /color-palettes/:id/colors
    PATCH  /vendor-colors/:id
    DELETE /vendor-colors/:id
    POST   /color-palettes/:id/colors/import      paste a chart; dryRun previews
    POST   /product-color-specs
    PATCH  /product-color-specs/:id
    DELETE /product-color-specs/:id
    GET    /vendor-colors/spec?productId=&sku=    "does this line take colours?"

Reading is `CATALOG_READ` so the proposal editor can offer the list; writing is
`PRODUCTS_ADMIN`. Every write is audited under `vendorColor.*`.

## Rules the server enforces

- A colour must be on the product's own palette, active, and in a slot within
  1…`slotCount`. Names and codes are read from the palette, never from the
  request, so a client cannot rename a colour by posting one.
- Two picks for one slot are refused; a slot left blank is not an error unless the
  spec is marked required.
- A product gets one spec. A second would make the number of colours a matter of
  query order.
- A spec cannot be moved onto another vendor's palette — that would quote colours
  the supplier of that part does not make.
- Upcharge = per-slot fabrication charge + the colour's own upcharge, counted only
  for slots actually chosen.

## Still to wire (not in this drop)

The picker on the proposal line and on the BOM sheet. The pieces it needs are
here — `GET /vendor-colors/spec` per line, `normalizePicks()` on save,
`colorUpchargeMinor()` for the line total, `picksFromProposalItem()` when the
order is created, and `describePicks(picks, { withVendorCode: true })` for the
sheet — but the proposal editor and BOM renderers in `app.js` have not been
touched. Say the word and that goes in next.

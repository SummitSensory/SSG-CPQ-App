# Retest — Catalog extracted (AUD-003 step 3)

The extraction the whole shared-primitives exercise was for.

**`app.js`: 15,456 → 13,006 lines.** Down from 16,083 when this began — a 19% cut in this
commit and 3,077 lines total.

## Files — copy all seven together

`eslint.config.js` did not land last round, so its `SSGVendorParts` entry is included
here too. No harm was done by that (`app.js` uses `window.SSGVendorParts`, a property
access, so `no-undef` never fired and the clean `lint:count` was honest), but it should
be caught up.

| File                          |                                                 |
| ----------------------------- | ----------------------------------------------- |
| `public/catalog.js`           | **new** — the Catalog screen, 2,537 lines       |
| `public/app.js`               | replace — 15,456 → 13,006                       |
| `public/index.html`           | replace — new tag before `app.js`; `app` v121   |
| `src/routes/web.ts`           | replace — route for `catalog.js`                |
| `eslint.config.js`            | replace — `SSGVendorParts` **and** `SSGCatalog` |
| `.prettierignore`             | replace — `catalog.js`                          |
| `scripts/ssg-ui-selfcheck.js` | replace — 74 assertions (was 73)                |

**Copy all seven or none.** `app.js` now calls `window.SSGCatalog.render(user)` from the
nav, so `app.js` without the `index.html` tag means clicking Catalog throws.

## What I ran before handing this over

- All six touched JS files parse.
- `client-scripts.test.ts` simulated: 21 tags, 21 routes, no tag without a route, no route
  without a tag, no duplicates, `ssg-ui.js` first, `catalog.js` and `proposal-document.js`
  both before `app.js`.
- Every `window.SSG*` global `app.js` reaches for is registered by a file that is
  actually tagged. All ten check out.
- All four module globals declared in `eslint.config.js`.
- Self-check run against the real four modules: **74 passed, 0 failed**, and
  `SSGCatalog.render` resolves to a function.
- The 2,451 moved lines are brace-, paren- and bracket-balanced against the original, and
  the body is byte-identical to what left `app.js`.

## Commands

```powershell
pnpm lint:count
pnpm test:unit
```

`test:unit` is the one that matters most this time — `client-scripts.test.ts` is your
existing guard against exactly the wiring mistake this commit could make, and I have only
simulated it here.

## Console

Paste `scripts/ssg-ui-selfcheck.js`. Expect **74 checks passed**.

## The screen — all six tabs

Catalog is one screen with one entry point now, so if it renders at all the wiring is
right. What is worth clicking is the parts with real logic behind them.

| ✓   | Tab / action                                                            |
| --- | ----------------------------------------------------------------------- |
| ☐   | **Catalog** — the merged list loads; sort a column; use a column filter |
| ☐   | Edit a row inline (name, cost, price) and confirm it saves              |
| ☐   | **Product tree** — categories render; drag to reorder                   |
| ☐   | **Bundles**                                                             |
| ☐   | **Manufacturers** — list loads; open the vendor-parts dialog            |
| ☐   | **BOM build** — components and free-issue                               |
| ☐   | **Proposal notes** — the shared panel still renders here                |
| ☐   | **History** button — on at least two different tabs                     |
| ☐   | **SKU / pricing import** — the largest sub-section, 570 lines. Paste or |
|     | upload a small sheet and check the preview counts before committing     |
| ☐   | **Product-tree workbook** — export, then re-import the same file        |

The two shared panels are reached from here through their own globals now, so
**Proposal notes** and the **vendor-parts dialog** are the two places where this
extraction could have broken something that is not Catalog's own code.

## Still outstanding, unchanged

- **Step 5, after 6pm** — the proposal date test. Highest stakes of anything left.
- The vendor-parts two-screen check, if not yet done.

## Next, and a question waiting on you

Two things are queued behind an answer from you:

**The manufacturer dropdown.** The column is already declared `type: 'enum'`, the list is
already fetched into `itemState.manufacturers`, and `sel()` already exists and is already
used for the category column. Manufacturer alone renders a text box. Wiring it is one
line — but `sel()` selects nothing when the current value is not in the list, so the
browser shows the blank option and the next save would write that blank. That would
convert existing misspellings into missing vendors, silently, which is worse than the
typo. So it needs the current value carried through as a flagged option, and it needs a
one-query check first: which `Sku.manufacturer` values match no `Manufacturer.name`.

**One place to add or update a product.** Editing already merges — `PATCH
/catalog/items/:part` fans a single edit across `Product`, `Sku`, `ProductSourcing` and
`Manufacturer`, creating the `Sku` on demand. So the question is what the second tab is
actually for in your workflow: **creating** the product, or **placing** it in the tree
(tier, sort order, default quantity)? Those are different fixes.

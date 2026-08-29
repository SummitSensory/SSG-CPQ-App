repo: SummitSensory/SSG-CPQ-App
branch: main

## Last sync

date: 2026-08-29T18:52:00Z

Read-only access. Changes are handed over as files and applied locally; `main` is read to
establish the committed baseline and to confirm a hand-off landed.

No commit sha recorded: `github_get_tree` resolves a tree hash, not a commit, and guessing
one is worse than omitting it.

### Updated in this project

- **Catalog data integrity (Pass 2).** 194 parts existed as half of themselves — a `Product`
  row with no `Sku` — and 192 were ACTIVE, so the proposal builder offered them at $0.00.
  All 194 completed; exposure closed. Invariants now enforced by `pnpm check` and 15
  integration tests.
- **Vendor identity can no longer diverge.** `PATCH /catalog/items/:part` used to create a
  Manufacturer row for any unrecognised name. Refused now, before any write. The two import
  paths that wrote only `Sku.manufacturer` also write `ProductSourcing`.
- **Workbook round trip carries prices** in both directions. Zod was silently stripping the
  price columns on import while reporting success.
- **One place to add a part.** `POST /catalog/items` writes both rows in one transaction.
- **Nine money-path integration tests revived** — accepted-order locking and QuickBooks
  idempotency guards that had never run.
- **AUD-003 step 3:** Catalog screen extracted. `app.js` 16,083 → 13,138 lines.
- **Proposal reordering**, history CSV export, manufacturer dropdown.

## Screen map

| Screen / concern                                             | Built from                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Shared UI primitives                                         | `public/ssg-ui.js`                                           |
| Catalog (six tabs)                                           | `public/catalog.js`                                          |
| Standard proposal notes                                      | `public/ssg-standard-notes.js` — used by Catalog AND Admin   |
| Vendor part numbers                                          | `public/ssg-vendor-parts.js` — used by Catalog AND Admin     |
| Customer proposal document                                   | `public/proposal-document.js`                                |
| Proposal builder, shell, CRM, Reports, Orders/BOM/QBO, Admin | `public/app.js`                                              |
| Catalog part CRUD                                            | `src/routes/catalogItems.ts`                                 |
| Product tree + workbook                                      | `src/routes/productTree.ts`                                  |
| SKU list + CSV import                                        | `src/routes/skus.ts`                                         |
| Catalog invariants                                           | `src/catalog/partIntegrity.ts`, `src/catalog/partVendor.ts`  |
| Client script allow-list                                     | `src/routes/web.ts` (`CLIENT_SCRIPTS`) + `public/index.html` |
| Portal colour selection                                      | `src/portal/colorSelection.ts`, `src/routes/portal.ts`       |

## Data-model notes for the next session

Read `prisma/schema.prisma` before writing any rule about these. Three separate sessions'
worth of wasted effort came from inferring the model from field names.

- **A part is two rows.** `Product` (name, category, tree position, sourcing) and `Sku`
  (price, cost, weight, vendor), joined by part number. Drift between them is now detected
  by `pnpm db:check:integrity`, but the duplication itself remains.
- **Three different "category" fields, three jobs.** `Product.categoryId` = tree position.
  `Sku.category` = a part TYPE code (FRAME, TROLLEY, ACCESSORY) for filtering and
  reporting. `Sku.proposalGroup` = the heading a proposal files it under. They are NOT
  copies of each other; `src/reporting/dataset.ts` documents this.
- **`ProductSourcing` is many-to-many** with `@@unique([productId, manufacturerId])` and an
  `isPrimary` flag that **defaults to true**. A part can list several vendors, and typically
  has several flagged primary. Never collapse it to one vendor per part.
- **The Bill of Materials reads `Sku.manufacturer`** as the override, so that is who a part
  is actually ordered from. `ProductSourcing` is what vendor reports and the freight
  true-up read.
- **The proposal builder snapshots the rate onto the line** when it is added, rather than
  reading the catalog at print time. This is why 192 parts priced at $0.00 never produced a
  wrong customer document. Do not "improve" it into a live lookup.

## Commands

```
pnpm check                    # typecheck, lint, migrations, catalog integrity
pnpm test                     # unit + integration (80 integration tests)
pnpm db:check:integrity       # catalog invariants against the database
pnpm db:repair:half-parts     # dry run; --commit to apply
pnpm db:align:vendors         # dry run; --commit to apply
```

## Outstanding

- **Browser verification** of the 2026-08-29 UI work — proposal reordering, the New part
  form, history CSV export, the manufacturer dropdown, and the six Catalog tabs. None has
  been opened in a browser; all were verified only by unit assertions and `tsc`.
- **189 parts need prices.** They are complete but inactive. Export the tree workbook, fill
  `unitPrice`/`unitCost`, dry-run the import, commit, set active.
- **`SVC-CON-HR` and `SVC-DES-SITE`** are inactive (no proposal had used them). Give them a
  rate if reps quote consulting hours or site visits.
- **`isPrimary` should default to `false`** with create paths setting it explicitly.
- **AUD-021 date retest** needs a west-of-UTC clock after 5pm local: Proposal Date and
  Expiration Date on a preview, a print and the server PDF, US and Canadian, plus a packing
  slip.
- **`PORTAL_COLOR_SELECTION` is `off`.** Before switching it on, confirm who edits the
  Jotform colour forms today — the palette is administered in the CRM but the question
  wording is code.

## Notes on hand-offs

One folder per round, containing only the files that round touches, line endings matched to
each file's existing convention, with the expected `git diff --stat` stated up front.
Delivery notes are never named `README.md` and never land at the repo root — an early round
overwrote the project README that way.

The pre-commit hook (`prettier --write` + `eslint --fix`) caught three defects in this
session that no amount of reading would have: an unused binding in `catalog.js`, a dead
`slugify` in `catalogItems.ts`, and a dead `catById` in `partIntegrity.ts`. Run
`npx tsc --noEmit` and `pnpm lint` before committing rather than after.

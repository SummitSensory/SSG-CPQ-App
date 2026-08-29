# AUD-003 step 3 — Catalog: the measured plan

Written 2026-08-28, after step 1 landed clean. Every number here is measured against
`public/app.js` at its current 15,920 lines, not estimated.

---

## Did step 1 work?

Yes, and by the predicted margin.

| Screen         | Total needs from the shell | Satisfied by `SSGUI` | Still needs `app.js` | Note's estimate |
| -------------- | -------------------------- | -------------------- | -------------------- | --------------- |
| Catalog        | 22                         | 17                   | **4**                | 21 → ~4         |
| Administration | 38                         | 17                   | **21**               | 30 → ~13        |

Catalog is what the note promised. **Administration is not**, and that is the more
useful finding — see the last section.

Method: every top-level declaration in the `app.js` closure (580 of them) against every
identifier referenced inside the screen's line range, excluding names the screen
declares itself. Two hits were false positives and were confirmed by eye rather than
trusted: `rep` inside Catalog is a local `var rep = pv.querySelector('#vpReport')` at
line 3469, and `cat` outside it is a local `var cat = Number(p.catalogCostMinor)` at 11458.

---

## Catalog, as it stands

Lines **1646–4394**, 2,749 lines, 89 top-level declarations. Nine sub-sections:

| Lines     | Section                                         |
| --------- | ----------------------------------------------- |
| 1646–1948 | Catalog shell and tabs                          |
| 1949–2023 | The merged Product + SKU list, one row per part |
| 2024–2435 | Column filters (shared with the product tree)   |
| 2436–2465 | `renderCatalogProducts`                         |
| 2466–3035 | SKU / pricing manager, plus Excel/CSV import    |
| 3036–3651 | Manufacturers                                   |
| 3652–3850 | Bundles                                         |
| 3851–4025 | Product tree: categories, order, workbook       |
| 4026–4394 | Product-tree workbook export and import         |

### What it needs — 4 things

| Need                   | Declared | Handling                                                                   |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `authed`               | 345      | **Inject.** The established pattern — `H.authed`, as five files already do |
| `canCatalogAdmin`      | 517      | **Copy.** One line, and pure: `role === 'SYSTEM_ADMIN'`                    |
| `loadStandardNotes`    | 14530    | See "the two tangles"                                                      |
| `openStandardNoteForm` | 14558    | See "the two tangles"                                                      |

`canCatalogAdmin` is the `hasRole` case again: it looks like it reads the signed-in user
and does not — the role is an argument. Copy it, do not thread it.

### What the shell needs from it — 1 entry point

Of Catalog's 89 declarations, **85 are referenced nowhere outside the block.** The
public surface is:

- `renderCatalog` — 2 references, both nav dispatch (lines 634 and 838). The entry point.
- `streetLine` (line 4092) — does not belong to Catalog at all; see below.
- `openVendorParts` (line 3266) — see "the two tangles".

A screen with one entry point and 85 private functions is the cleanest extraction target
in this file.

---

## Do these three first

Each is small, independently shippable, and each removes a reason Catalog cannot leave.
None of them is the extraction itself.

### 1. `streetLine` → `ssg-ui.js` (7 lines)

A pure address formatter that happens to sit in Catalog's workbook section. Its callers
are the proposal builder (line 6301) and the Bill of Materials (line 12867) — **neither
is Catalog.** It is in the Catalog block by accident of where someone was working.

It belongs with the other pure formatters. Add it to `SSGUI`, alias it in `app.js` like
the rest, and Catalog loses a public export it never should have had.

### 2. The standard-notes panel → its own file (~70 lines)

`loadStandardNotes` (14530) and `openStandardNoteForm` (14558) render one panel, and
**both Catalog and Administration render it.** Both wire the same `#snNew` button — line
1942 in Catalog, 14519 in Administration — and both call `loadStandardNotes()`.

So this is not "Catalog reaching into Administration." It is a shared panel with no home,
currently filed under Administration because that is where it was written. Give it one:
`public/ssg-standard-notes.js`, registering `window.SSGStandardNotes` with `mount` and
`install`, exactly like `accounts-receivable.js` and `insights.js` already do.

### 3. The vendor-parts dialog → its own file (~230 lines)

`openVendorParts` (3266–3496) is the mirror image: it lives in **Catalog** and
**Administration** calls it, at line 15060 (`openVendorParts(m, currentUser)`).

Same shape, same remedy: `public/ssg-vendor-parts.js`. Note it takes `currentUser` as an
argument at that call site, so the dialog itself does not read live state — it is passed
in, which is the right shape already.

**These two are the same defect twice, in opposite directions.** A dialog owned by one
screen, opened from the other. Resolve both and Catalog and Administration stop being
coupled to each other at all — which matters more for step 4 than for step 3.

---

## Then Catalog

With the three above done, Catalog is:

- 2,749 lines minus `streetLine` (7) and `openVendorParts` (231) ≈ **2,510 lines**
- **one** entry point: `renderCatalog(user)`
- **one** injected dependency: `authed`
- **one** copied line: `canCatalogAdmin`

That is a smaller and better-understood move than the proposal document was, and the
proposal document is already out.

Shape it the same way the extracted screens are shaped: `public/catalog.js` registering
`window.SSGCatalog`, `var H = null` for the injected host helpers, `init(H)` called
during boot. Then the three-part rule — the file in `public/`, its route in
`CLIENT_SCRIPTS`, and a `<script>` tag in `index.html` — which
`tests/unit/client-scripts.test.ts` now enforces in both directions.

### Two cautions carried forward

**Scan for bare identifiers, not just calls.** The proposal-document extraction missed
five dependencies because the call-graph walk looked for `name(` and these were bare.
The measurement above uses a plain identifier regex for exactly that reason, but it
cannot see through scope: verify with `pnpm lint:count` — `no-undef` on `public/**` is
what caught those five, and it is what will catch these.

**Run the self-check.** `scripts/ssg-ui-selfcheck.js`, pasted into the console: 94
assertions that the primitives still behave. It is proven to catch a narrowed `esc`, a
reverted `todayISO`, a changed `td`, a deleted member and a wrong script order. Run it
after this extraction and after every later one.

---

## Administration: the estimate was wrong

The note called Administration "changed rarely, low risk to move" and predicted ~13
remaining needs. Measured: **21**, and the composition is the problem, not the count.

Administration reaches into five other areas of the file:

| Reaches into     | Names                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Proposal preview | `proposalDocData`, `proposalStandaloneHtml`, `proposalFileName`                |
| The shell itself | `renderShell`, `renderLogin`, `shell`, `refresh`, `clearTokens`, `currentUser` |
| Configurator     | `adv`                                                                          |
| Reports          | `bar`, `rep`                                                                   |
| Rich-text editor | `richTextField`, `readRichText`, `wireRichText`                                |
| Catalog          | `openVendorParts`                                                              |

Reaching into the shell's own render and logout is not "low risk" — it is the screen that
is most entangled with the shell, because it is the screen that changes the shell (roles,
settings, sessions).

**Recommendation: reorder.** After Catalog, take **Configurators** (1,297 lines) next and
leave Administration for after that. The rich-text editor is a red herring —
`richTextField` has only 2 references in the whole file and `wireRichText` 2, so it moves
_with_ Administration rather than into `ssg-ui.js`. It is not a shared primitive; it just
looks like one.

Revised order: Catalog → Configurators → Administration. The builder and
Orders/BOM/QuickBooks stay where they are; both sit on the money path.

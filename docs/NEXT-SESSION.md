# Next session — AUD-003 step 1: the shared primitives module

Written 2026-08-28 at the end of a long audit session. Everything here is verified
against the current `public/app.js`, not remembered. Line numbers are from the commit
`2149d53` state of that file (15,789 lines).

Read `SOFTWARE_AUDIT.md` first — sections 4 (AUD-003) and 12 carry the full history.

---

## What is being built, and why

`public/app.js` is 15,789 lines with no module boundaries: a syntax error anywhere in
it blanks the entire workspace. The remedy is to lift screens out one at a time, and
the proposal document (`public/proposal-document.js`) has already gone.

Every subsequent extraction was measured, and they all stall on the same thing. The
Catalog screen needs 21 things from the shell; **seventeen of them are UI primitives
that every other screen also needs.** Administration's 30 needs contain the same
seventeen. So does CRM's, and Reports'.

The blocker is not per-screen coupling. It is that there is no shared foundation. Fix
that once and every later extraction becomes cheap — Catalog drops from 21 needs to
about 4, Administration from 30 to about 13.

It also retroactively de-duplicates the copies already sitting in
`accounts-receivable.js`, `insights.js`, `goals.js` and `proposal-document.js`.

---

## The primitives, verified present in `public/app.js`

| Name             | Line  | Refs | Notes                                                        |
| ---------------- | ----- | ---- | ------------------------------------------------------------ |
| `esc`            | 14    | 780  | HTML escaping. The single most-used thing in the file        |
| `titleCase`      | 15    | 44   |                                                              |
| `rtUnescapeTags` | 34    | 2    | Only `rt` uses it; moves with `rt`                           |
| `rt`             | 49    | 22   | Note markup. **Shared with the builder** — see caution below |
| `todayISO`       | 177   | 15   |                                                              |
| `fmtDate`        | 181   | 43   |                                                              |
| `fmtMoney`       | 187   | 80   |                                                              |
| `hasRole`        | 544   | 30   | Reads `currentUser` — see caution                            |
| `roleLabel`      | 553   | 3    |                                                              |
| `td`             | 1280  | 301  | Table cell                                                   |
| `openModal`      | 1307  | 71   | Reads/writes the DOM; self-contained                         |
| `fieldRow`       | 1660  | 160  |                                                              |
| `formSection`    | 1662  | 3    | Added 2026-08-28 for the user-edit form                      |
| `IN`             | 1666  | 212  | The shared input style string                                |
| `selectEl`       | 1667  | 7    |                                                              |
| `tableShell`     | 4237  | 23   |                                                              |
| `statusChip`     | 4731  | 8    |                                                              |
| `fmt0`           | 5554  | 45   |                                                              |
| `kpi`            | 5616  | 41   |                                                              |
| `d2m`            | 6000  | 15   | Dollars to minor units                                       |
| `money`          | 10923 | 40   |                                                              |
| `costMoney`      | 11196 | 15   |                                                              |
| `bomFieldStyle`  | 11314 | 32   |                                                              |
| `fmtDateTime`    | 11919 | 8    |                                                              |
| `toast`          | 13256 | 11   |                                                              |
| `downloadCsv`    | 13314 | 10   |                                                              |
| `downloadBlob`   | 14239 | 4    |                                                              |
| `serverMessage`  | 15505 | 42   | Reads a `Response`; async                                    |

That is 28 candidates, not 17 — the seventeen were the ones Catalog happened to need.
Take the whole set; a foundation that covers half the primitives leaves every screen
still reaching into the shell.

---

## Two cautions, learned the hard way today

**1. Scan for bare identifiers, not just calls.** The proposal-document extraction
missed five dependencies because the call-graph walk looked for `name(` and these were
bare: `rt`, `FREIGHT_TBD_NOTE`, `pb`, `currentUser`, `tc`. ESLint's `no-undef` on
`public/**` caught them before they shipped. Use a plain identifier regex over the
moved text and check every match against the shell's declarations.

**2. Not everything that looks like formatting is.** Of those five, four could not be
copied:

- `rt` renders note markup and is shared with the builder, which shows the rep the same
  note as they type it. Two implementations and the preview stops matching the printed
  page.
- `FREIGHT_TBD_NOTE` is a sentence that prints on a document a customer signs.
- `pb` and `currentUser` are live mutable state.

`hasRole` has the same shape as `pb`/`currentUser` — it reads the signed-in user. It
either takes the user as an argument, or the module gets a `currentUser()` accessor
supplied by `app.js`. Decide deliberately; do not copy it.

The pattern that worked: **pure formatters get copied or moved outright; anything
reading live state or printing on a customer document gets injected.**
`proposal-document.js`'s `useRules()` is the working example — it throws on a missing
rule rather than falling back, which is what turned a silent wrong-deposit risk into a
loud startup failure.

---

## Files to touch, all in one commit

| File                            | Change                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| `public/ssg-ui.js`              | **New.** The primitives, registering `window.SSGUI`                  |
| `public/app.js`                 | Remove the moved declarations; reference `SSGUI`                     |
| `public/index.html`             | `<script src="/ssg-ui.js?v=1">` **first**, before every other script |
| `src/routes/web.ts`             | Add `'ssg-ui.js'` to `CLIENT_SCRIPTS`                                |
| `public/accounts-receivable.js` | Drop its local copies, use `SSGUI`                                   |
| `public/insights.js`            | Same                                                                 |
| `public/goals.js`               | Same                                                                 |
| `public/proposal-document.js`   | Same, for the six formatters copied into it                          |
| `public/freight-trueup.js`      | Same                                                                 |
| `public/belt-shipments.js`      | Same                                                                 |

`tests/unit/client-scripts.test.ts` already asserts that every `<script>` tag has a
route and vice versa, and that `proposal-document.js` loads before `app.js`. Extend it
to assert `ssg-ui.js` is first.

---

## Verification, before committing

```powershell
npx tsc --noEmit          # must be silent
pnpm lint:count           # must be 0 — this is what catches a missed dependency
pnpm test:unit            # 48 files, 469 tests as of 2149d53
```

Then, in the browser, every screen — because a missing primitive fails at render time
on one screen only: Dashboard, CRM, Catalog (all six tabs), Proposals, the builder,
Reports, Orders, a Bill of Materials, Accounts Receivable, Insights, Goals,
Administration (all five tabs), and a proposal preview in both US and Canadian form.

That list is long on purpose. `esc` has 780 references and `td` has 301; a mistake in
either is everywhere at once, and the only way to know is to look.

---

## After this

3. **Catalog** — 2,559 lines, 92 functions. The largest clean win.
4. **Administration** — 1,942 lines.
5. **Configurators** — 1,297 lines.

Leave the **proposal builder** (3,468 lines, 15 entry points) and **Orders / BOM /
QuickBooks** (3,440 lines, 22 entry points) alone. Both sit on the money path and the
gain does not justify the risk until the pattern is well worn.

---

## Also still open, unrelated to this

- **Portal token replay** — the last security item. Mint a colour-selection link,
  submit it, submit the same token again, then alter one character. Expect accepted,
  refused-or-idempotent, 404.
- **`GET /health/references`** — one authenticated call; counts dangling `*ById` ids.
  Never run against real data.
- **BOM `.xlsx`** — needs a human to open one in Excel and judge the styling.
- **AUD-001 Part 2** — the migration squash. Procedure in
  `docs/database-migrations.md`; rehearse on a Neon branch.

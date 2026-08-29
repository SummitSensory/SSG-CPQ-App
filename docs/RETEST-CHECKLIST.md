# Retest checklist — AUD-003 step 1 and its follow-ons

Everything below needs a person. Work top to bottom; each step gates the next.

Budget: about 40 minutes for steps 1–4, plus one evening check for step 5.

---

## Step 1 — Copy three files (2 min)

From `fixes/`, over the top of the originals:

- `scripts/ssg-ui-selfcheck.js` _(new file)_
- `docs/AUD-003-STEP-3-CATALOG.md` _(new file)_
- `docs/NEXT-SESSION.md` _(replaces)_

No source files this round. Nothing in `public/` or `src/` changed.

---

## Step 2 — Three commands (5 min)

```powershell
npx tsc --noEmit          # must print nothing
pnpm lint:count           # must be 0
pnpm test:unit            # all green
```

You have already run these once and they were clean. Run them again after the copy —
`scripts/` is not prettier-ignored, so if `pnpm format:check` complains about the new
self-check file, run `pnpm format` on it and move on. It is a diagnostic, not shipped
code; reformatting it is harmless.

**If any of the three fails, stop and send me the output.** Do not go to step 3.

---

## Step 3 — The self-check (1 min)

1. Open the app and **sign in** (it needs a rendered, authenticated page).
2. Press **F12** → the **Console** tab.
3. Open `scripts/ssg-ui-selfcheck.js`, select all, copy.
4. Paste into the console, press **Enter**.

**Pass looks like:** one green line, `SSGUI SELF-CHECK — all 67 checks passed.`

**Fail looks like:** a red line with a count, then a table of what broke. If you see
that, **stop and send me the table.** A failure here means the primitives module itself
regressed, and hunting through screens would waste your time — the bug is in one file,
not fifteen.

One honest limitation: the `todayISO is today, locally` assertion only has teeth when
your local date differs from the UTC date — which in Mountain time means **after 6pm**.
Run it before 6pm and that one check passes without proving anything. Step 5 covers it
properly.

---

## Step 4 — The screen walk (30 min)

This is the one that matters and the one I cannot do. `esc` has 780 references and `td`
has 301; a broken alias does not fail a test, it fails a render.

**What you are looking for, on every screen.** Four signatures cover almost everything:

| You see                                                                | Broken primitive       |
| ---------------------------------------------------------------------- | ---------------------- |
| `—` where a number or date belongs                                     | `fmtMoney` / `fmtDate` |
| A table with headers but no rows, or "No records." with data behind it | `tableShell` / `td`    |
| A dialog opens, you click Save, nothing happens                        | `openModal`            |
| Note text loses its **bold** or runs together                          | `rt`                   |

Anything blank, anything `undefined` on screen, and any red line in the console counts
too. Keep the console open the whole way through.

Tick each row. The right-hand column is what that screen leans on hardest, if you want
to know where to look first.

| ✓   | Screen                                          | Leans on                                     |
| --- | ----------------------------------------------- | -------------------------------------------- |
| ☐   | **Dashboard**                                   | `kpi`, `fmt0`, `fmtMoney`, `statusChip`      |
| ☐   | **CRM** — list, then New organization           | `td`, `tableShell`, `openModal`, `selectEl`  |
| ☐   | Catalog → **Catalog** tab                       | `td`, `money`, `costMoney`, `bomFieldStyle`  |
| ☐   | Catalog → **Product tree**                      | `tableShell`, column filters                 |
| ☐   | Catalog → **Bundles**                           | `td`, `openModal`                            |
| ☐   | Catalog → **Manufacturers** (open vendor parts) | `openModal`, `bomFieldStyle`                 |
| ☐   | Catalog → **BOM build**                         | `bomFieldStyle`, `selectEl`                  |
| ☐   | Catalog → **Proposal notes**                    | `rt` — check **bold survives**               |
| ☐   | **Proposals** list                              | `statusChip`, `fmtDate`, `fmtMoney`          |
| ☐   | Open one → **the builder**                      | `money`, `d2m`, `rt`                         |
| ☐   | **Proposal preview — US**                       | `fmtDate`, `fmtMoney`, `rt` ⚠ see step 5     |
| ☐   | **Proposal preview — Canadian**                 | cross-border figures, `fmtDate`              |
| ☐   | **Mock Proposal**                               | the whole document path                      |
| ☐   | **Reports** (all tabs)                          | `kpi`, `fmt0`, `downloadCsv`                 |
| ☐   | **Orders & Bill of Materials** list             | `td`, `fmtDateTime`, `downloadCsv`           |
| ☐   | Open one → **a Bill of Materials**              | `bomFieldStyle`, `costMoney`, `fmtDateTime`  |
| ☐   | **Belt Shipments**                              | `fmtStamp` ⚠ **changed this round**          |
| ☐   | **Accounts Receivable**                         | `fmtStamp` ⚠ **changed this round**          |
| ☐   | **Insights**                                    | its own copies — should be untouched         |
| ☐   | **Goals**                                       | its own copies — should be untouched         |
| ☐   | Administration → **Users**                      | `fieldRow`, `formSection`, `IN`, `roleLabel` |
| ☐   | Administration → **Proposal content**           | `rt`, the rich-text toolbar                  |
| ☐   | Administration → **Email**                      | `openModal`, `rt`                            |
| ☐   | Administration → **Pricing & formulas**         | `fieldRow`, `d2m`                            |
| ☐   | Administration → **Orders & vendors**           | `openModal`, `bomFieldStyle`                 |
| ☐   | Administration → **Canada**                     | cross-border panel mounts                    |
| ☐   | **Integrations**                                | `fmtDateTime`                                |

**Two specific things to check by eye, not just "does it load":**

1. **Apostrophes.** `esc` now escapes `'`. Save an organization or a proposal title
   containing one — `O'Brien Children's Therapy` — and confirm it shows as typed, **not
   as `O&#39;Brien`**, in: the list, the edit form's input, the proposal preview, and a
   CSV export of that table. Four places, one name.
2. **The timestamps I changed.** On Belt Shipments look at "shipped at" and the "Last …"
   line on a summary row; on Accounts Receivable look at "payment request sent". **The
   date and the time in each must agree with each other.** Before this round they did
   not — the date came from UTC and the time from your clock.

---

## Step 5 — The date test, after 6pm (5 min)

This is the AUD-021 retest and it **cannot be done during the working day** — the bug
only appears when your local date and the UTC date disagree, which in Mountain time
means after 6pm.

No timezone change needed. Just do this after 6pm local:

1. **Create a new proposal.** Open its preview. The **Proposal Date** must be today's
   date, not tomorrow's.
2. Check the **Expiration Date** on the same preview.
3. **Print it** (or open the server PDF). Both must show the same dates as the screen.
4. Do 1–3 again on a **Canadian** proposal.
5. **Make one packing slip** on Belt Shipments. Its date must be today.
6. Paste the self-check again. Now the `todayISO is today, locally` assertion is
   meaningful — it must still pass.

If you would rather test this in the afternoon: set the machine's time zone to **Hawaii**
(UTC-10) and anything after 2pm local reproduces the same condition. Set it back after.

---

## Step 6 — Tell me

Send me:

- The self-check line (green count, or the red table).
- Any screen from step 4 that looked wrong, and what you saw.
- The six results from step 5.
- Whether the apostrophe test came out clean in all four places.

Then I start on the three small moves that unblock Catalog — `streetLine` to `ssg-ui.js`,
the standard-notes panel to its own file, the vendor-parts dialog to its own file — which
are all mine, not yours.

---

## Not part of this, but still open when you want them

| Job                          | What it needs                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BOM `.xlsx` styling**      | Open one downloaded BOM in Excel and judge how it looks                                                                                                                                                                                              |
| **`GET /health/references`** | One authenticated call. **Never against real data**                                                                                                                                                                                                  |
| **AUD-006**                  | Point a schedule at a user with no Outlook connection                                                                                                                                                                                                |
| **AUD-001 Part 2**           | The migration squash. Rehearse on a Neon branch first                                                                                                                                                                                                |
| **Portal colour selection**  | Before `PORTAL_COLOR_SELECTION` leaves `off`: confirm who at Summit edits the Jotform colour forms today. The palette is administered in the CRM, but the question wording is code — that is a capability the current flow has and this one does not |

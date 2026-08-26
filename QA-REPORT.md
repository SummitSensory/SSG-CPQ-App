# QA report — Adventure Series hardware pipeline

Date: 2026-08-04
Scope: proposal builder hardware section, H-1000 roll-up, logic trace, QuickBooks link
writer. Method: static review of `src/proposals/adventureSeries.ts`,
`src/proposals/hardwareRules.ts`, `src/routes/adventure.ts`, `src/routes/formulas.ts`,
`public/app.js`, `src/integrations/quickbooks/links.ts`, cross-checked against the two
builder screenshots supplied. The automated suite (`pnpm test`, Playwright) was not run
in this environment — see _Still to run_.

## Issues found

**1 · An answered eye-bolt quantity never reached the proposal** — severity: high
`# of 360 Swivel / 180 Eye Bolts` was answered 4; no `6820H-LDD` line printed.
Cause: the accessory lines took their quantity **only** from the `HardwareRule` table.
`if (row.qty <= 0) continue` discarded the answer whenever that part's rule row was
missing, inactive or saved with no terms — a state any edit in Administration →
Formulas can leave behind. `6820H-LP` and `B0C4Y8XSNB` survived because their rows
still evaluate.
Fix: `accessoryAnswerQty()` gives every configurator-answered part a floor. A rule may
add to a typed quantity (`6820H-LP` also covers the zip-line BOM); it can no longer
erase one.

**2 · No subcategory under the Hardware section** — severity: medium
Cause: the Hardware block pushed line items directly instead of going through
`emitExtras`, so it never read each part's tier-2 catalog placement. Every other
section of the proposal used the placement; Hardware did not.
Fix: the bracket and accessory lines route through `emitExtras`, so they print under
their catalog subgroup (`HARDWARE › Quick Shift`) in product-tree order.

**3 · A sub-heading named "Hardware" printed inside the HARDWARE section** — severity: medium
Visible in the second screenshot. Cause: two faults in `emitExtras`. It emitted the
leaf category name unconditionally, and the catalog files these fasteners under a
category named `Hardware` whose parent is also `Hardware` — so the group heading was
repeated as its own child. `emitExtras` also runs twice per section (chosen parts, then
catalog leftovers), so the same heading could print twice.
Fix: `G()` and `SG()` now track the open headings; a subgroup equal to its group, or to
a heading already open, is suppressed.

**4 · H-1000 printed at the bottom of the Hardware section** — severity: low
Cause: emit order — the roll-up was computed after the individual lines.
Fix: the kit line is emitted immediately after the Hardware heading. `hoistHardwareKit()`
in the builder also re-orders drafts built before this change when they are opened, so
nothing has to be regenerated. It runs on load and on generation only, not on every
render, so dragging a line still holds during a session.

**5 · The logic trace double-counted the named hardware** — severity: high (reporting)
`explainAdventure()` called `hardwareRollup(a, LOOK, rules)` with no exclusion list and
no frame rules. The brackets and eye bolts that print as their own proposal lines were
therefore also summed into the H-1000 figure in the trace, and the trace's frame BOM was
evaluated against default rather than saved frame rules. Trace revenue/COGS did not
match the proposal.
Fix: the trace excludes the same parts the engine excludes and is passed the saved frame
rules.

**6 · The trace listed no rows for the named hardware** — severity: medium
Consequence of 5: those parts appeared only inside the roll-up component list, so once
excluded they would have vanished from the trace entirely. They are now traced as their
own rows with the formula behind each quantity.

**7 · The stored kit breakdown could not be audited** — severity: high
`PricedLine.components` stored part, name, qty, unit cost and weight — no unit price and
no formula. Nothing downstream could show how a saved H-1000 line was priced, which is
why the logic could only be tested from inside the configurator.
Fix: unit price, quantity formula, catalog-presence and edited-formula flags now travel
on the line, so a draft built weeks ago can be audited from the proposal itself.

**8 · The new audit would have raised a false pricing alarm on every existing draft** — severity: medium
Found while testing 7. Drafts already in the database have no unit prices on their
components, so the component sum is $0 and the reconciliation against the line rate
would have flagged every one of them red.
Fix: the audit detects a breakdown with no stored prices and says so plainly instead of
reporting a fault.

**9 · Duplicate object key in `generateAdvLines`** — severity: low
`components: l.components || null` was written twice in the same object literal. Harmless
at runtime (last wins) but it is a real lint failure and hides a typo. Removed.

**10 · The audit button could open a bundle instead of the hardware kit** — severity: low
`hardwareKitLine()` matched any line carrying components, and catalog bundles carry
components too. Narrowed to SKU `H-1000`.

**11 · No proposal could be re-traced after the configurator was closed** — severity: high
Cause: the configurator answers lived only in the in-memory `adv` object; nothing was
written to the proposal. A draft therefore had no way to re-run its own logic.
Fix: answers are saved to `meta.advAnswers` on generation and travel with the version.
The audit gains **Re-run the live logic →**, which re-evaluates today's formulas and
catalog prices against that configuration. Drafts built before this deploy have no saved
answers; the stored breakdown still audits, and regenerating the lines enables the live
re-run.

**12 · Stale copy in the trace overlay** — severity: cosmetic
It claimed every fastener rolls into H-1000 and "none are billed separately", which
stopped being true when the named eye bolts began printing as their own lines. Reworded.

**13 · Six- and eight-leg frames generated no horizontal beam members at all** — severity: critical
Reported during this pass. Cause: `beamMembers()` matched stock members against the
frame's TOTAL length (`L === memLen[part]`), and stock members only exist at 5–10 ft.
Legs are derived from length — 4 legs up to 10 ft, 6 legs to 20 ft, 8 legs beyond — so
every six-leg frame is 11–20 ft and matched nothing. Long members, the 6-leg and 8-leg
additions, the interior beams and the monkey-bar beams all resolved to zero, and the
frame priced with posts and no beams. Nothing warned, despite the function's own comment
claiming multi-bay frames were "approximated and flagged for validation".
Fix: `beamSpans()` breaks the length into spans — a span is filled to 10 ft and the
remainder is the next one, so an 18 ft six-leg frame is 10 + 8, and an eight-leg frame is
10 + 10 + the difference. Each span draws its own member from the stock table. Width end
caps stay a property of the frame and are emitted once; interior beams and the monkey-bar
offset sit on the first span. The old `+3` / `+6` leg-count additions are gone: they were
the workbook's way of covering extra bays inside a single row, and the extra spans are
now emitted explicitly. A span that is not a stock length — 15 ft gives 10 + 5, fine, but
13 ft gives 10 + 3 — produces a warning instead of silence. It shows as a red internal
banner above the line items and in the logic trace, and never prints on the customer
proposal.
Check the per-span **counts** against the beam calculator on a real long frame. The span
lengths follow the rule you gave; the count per span is the workbook's single-bay count
applied to each span, which is an inference.

**14 · Proposals printed the previous day's date** — severity: high
An 4 Aug proposal printed 3 Aug. Cause: `fmtDate()` passed a bare `YYYY-MM-DD` to
`new Date()`, which parses it as UTC midnight; rendered in local time anywhere west of
Greenwich that is the previous evening. The PDF uses the same formatter, so it printed
the wrong date too.
Fix: a date-only string is parsed as a local calendar date. Two related faults came with
it: `new Date().toISOString().slice(0, 10)` supplied "today" in eight places including
the default proposal date, the approval date and the BOM submission date — that is the
UTC day, so it would begin stamping tomorrow's date each evening — and `addDays()`
round-tripped through UTC, shifting expiration dates east of Greenwich. Both now use a
local-date helper.

## Verified clean

- `upsertLink` in `src/integrations/quickbooks/links.ts` already carries the P2002
  duplicate-claim backstop and reports `conflict.claimedBy` rather than aborting a bulk
  run. The gap flagged during the item scan is closed in the repo.
- `loadFormulaRules` correctly separates FRAME and HARDWARE rules by `kind`, and treats a
  pre-0021 row with no `kind` as HARDWARE.
- `evaluateHardwareRules` resolves `hw:` dependencies by dependency order, guards
  circular references, and applies factor/rounding/minZero in workbook order.
- `placements()` recovers a part filed only in the SKU master from the category slug
  tail, so an accessory does not fall through to Hardware.
- `skuRows()` degrades safely when `Sku.overrideAllowed` has not been migrated.

## Corrected files

- `src/proposals/adventureSeries.ts` — issues 1, 2, 3, 4, 5, 6, 7, 13
- `public/app.js` — issues 4, 7, 8, 9, 10, 11, 12, 13 (warning banner), 14
- `public/index.html` — cache-bust to `v=42`

## Still to run

- `pnpm test` and the Playwright specs; issues 1–3 have no unit coverage today, and a
  regression test asserting "an answered accessory quantity always prints" is worth adding.
- The QuickBooks 12-step sandbox plan (item re-scan, `conflicts` array, `unmatchedCount`)
  is untouched by this work and still outstanding.

## After deploying

1. Open the draft and regenerate the Adventure Series lines, so the saved answers and the
   priced breakdown are written onto the version.
2. Confirm the Hardware section reads: HARDWARE → Hardware Kit (H-1000) → Quick Shift →
   bracket and swivel eye bolts, with no repeated "Hardware" sub-heading.
3. Open **Test the hardware logic →** and check the component sum matches the line, then
   **Re-run the live logic →** and check trace revenue matches the proposal total.

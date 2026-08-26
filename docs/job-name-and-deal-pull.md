# Job name default, and diagnosing the deal pull

## Files

| File                         | Role                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `src/handoff/bomSections.ts` | **Replace.** Adds `defaultJobName`, returns it on every section |
| `src/handoff/bom.ts`         | **Replace.** Same default on the order header                   |
| `public/app.js`              | **Replace.** Shows the default, and reports what the pull found |

```
copy /Y fixes\src\handoff\bomSections.ts src\handoff\bomSections.ts
copy /Y fixes\src\handoff\bom.ts src\handoff\bom.ts
copy /Y fixes\public\app.js public\app.js
pnpm typecheck
```

No schema change.

## Job name

Every vendor sheet now defaults to **`Customer - Sales Order #`** — e.g.
`Uniquely Yours Specialized Care - SO-2026-000063`. Type over it and your text wins and
stays; clear the field and it returns to the default.

It is computed rather than stored, which is what makes both halves true. Nothing is
written when a BOM loads, so there is no risk of a stale name persisting after a customer
is renamed, and an empty field still prints the right thing on the sheet. The field shows
the default as its placeholder so you can see what will print before typing anything.

The proposal title used to be the header fallback; it now sits behind this default rather
than ahead of it, since a vendor knows the job by the customer and the order number, not
by what we called the proposal internally.

## Why the pull showed nothing

The button was working — it just had no way to tell you _which_ of four things happened.
"Nothing populated" can mean the order is not linked to a monday deal, monday was
unreachable, the deal's own columns are empty, or every section already had a figure and
the pull deliberately left them alone. The old code raised the same vague alert for the
last two and a bare alert for the first.

It now reports beside the button exactly what the deal held:

```
Deal 12414494509: structure freight $1,240.00 · mats freight blank · tax $2,183.61
Filled in 2 sections, left 1 alone.
```

or, when there is nothing to copy:

```
Deal 12414494509: structure freight blank · mats freight blank · tax blank
Nothing to copy — those columns are empty on the Deal Tracking board.
Fill them in there, then pull again.
```

My expectation is that you will see the second one, because the Resilite section in your
screenshot reads **Mats freight from the deal** and the mats column (`text_mkzdpjf2`) is
the one most likely to be blank on an older deal — structure freight is a lookup that
populates itself, mats freight is typed by hand. The readout will tell you within one
click, and if it instead says the order is not linked to a deal, that is a different fix
and worth telling me.

Three things the readout also settles, if the columns turn out to be populated but the
values still look wrong:

- **Which column feeds which vendor** comes from `Manufacturer.bomFreightSource` — Resilite
  should be set to MATS, everyone else to STRUCTURE. Catalog → Manufacturers.
- **A figure you typed is never overwritten** by a pull. Only blank fields and the literal
  text `TBD` are treated as empty.
- **Submitted sections are skipped** — that sheet is the one the vendor already holds.

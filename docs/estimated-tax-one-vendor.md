# Estimated tax on one vendor only

## The change

The deal carries **one** tax figure for the job. It was being copied onto every vendor
section, so a three-vendor order read as though it owed the tax three times, and each
sheet's grand total was overstated by it. Tax now appears on the mats vendor's sheet only —
Resilite.

The rule is `Manufacturer.bomFreightSource === 'MATS'`, not a hard-coded vendor name. That
keeps it in the setting that already decides which of the deal's two freight figures a
vendor gets, so it is admin-editable under Catalog → Manufacturers rather than something
you need me for. If a second mats vendor is ever added, move the MATS setting rather than
duplicating it.

Applied in four places, so it holds everywhere the figure could surface:

- **The field** — Estimated Tax only renders on the mats vendor's section.
- **The totals** — the tax row and the grand total both drop it elsewhere. This is the part
  that was producing wrong numbers, not just clutter.
- **The PDF and Excel** — `bom.ts` suppresses it in `financials`, so a sheet already sent
  by hand cannot print it.
- **The pull** — it is no longer written to non-mats sections, and any value already stored
  on one is cleared. The display would hide it anyway; leaving it behind would make it
  reappear the day someone changes which vendor quotes the mats.

## Files

```
copy /Y fixes\src\handoff\bom.ts src\handoff\bom.ts
copy /Y fixes\src\handoff\bomSections.ts src\handoff\bomSections.ts
copy /Y fixes\public\app.js public\app.js
pnpm typecheck
```

No schema change. Existing tax values on other vendors clear themselves the next time
anyone pulls figures on that order; until then they are simply not shown or printed.

## Check it

On the order in your screenshot: Resilite keeps `160.09`, Goldberg Brothers and the
unassigned section lose the field and the row, and their grand totals drop by the tax. The
Resilite grand total is unchanged at $2,851.17.

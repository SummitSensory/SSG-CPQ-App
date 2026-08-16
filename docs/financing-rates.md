# Financing rebuild — banded rate sheets

## What changed and why

Ryan Capital's factor depends on **how much** is financed, not just the term. Their
workbook is a grid: amount band down, term across. The CRM held one factor per term —
the `$15,000–24,999` row — and applied it at every amount, so a $150,000 job quoted a
payment about 3% high and a $6,000 job quoted one low. The grid is now data.

Rate sheets are **versioned**. A new sheet from Ryan Capital is a new card with its own
effective date; the newest active card effective today is what new quotes use. Once a
financing sheet has been _sent_, the proposal version records which card produced it,
so loading next year's rates cannot restate a payment a customer already holds.

## Files

| File                                                      | Role                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                    | Complete, with `FinanceRateCard`/`Band`/`Rate` and `ProposalVersion.financeRateCardId` |
| `prisma/migrations/0051_finance_rate_cards/migration.sql` | The migration                                                                          |
| `src/proposals/financeRates.ts`                           | Card resolution, band matching, paste parser, the 2025 sheet                           |
| `src/proposals/financing.ts`                              | `quoteFinancing` reads the grid; returns a `basis`                                     |
| `src/handoff/financeDocument.ts`                          | Prints the band, and the estimate caveat                                               |
| `src/routes/finance.ts`                                   | Rate-sheet API; pins the card on send                                                  |
| `public/app.js`                                           | Grid editor, paste importer, band shown on the proposal                                |

`FinanceFactor` is untouched and still read as a fallback until a card is published, so
the migration alone changes nothing.

## Deploy

```
copy /Y fixes\prisma\schema.prisma prisma\schema.prisma
xcopy "fixes\prisma\migrations" "prisma\migrations" /E /Y
copy /Y fixes\src\proposals\financeRates.ts src\proposals\financeRates.ts
copy /Y fixes\src\proposals\financing.ts src\proposals\financing.ts
copy /Y fixes\src\handoff\financeDocument.ts src\handoff\financeDocument.ts
copy /Y fixes\src\routes\finance.ts src\routes\finance.ts
copy /Y fixes\public\app.js public\app.js
pnpm db:migrate:deploy
pnpm db:generate
pnpm typecheck
```

Then in the CRM: **Administration → Financing → Load Ryan Capital 2025**. One click
seeds the nine bands and five terms from the workbook. Confirm it with _Try an amount_:
$150,000 should quote the `$100,000 and above` band — 36 months at $4,749/mo.

## Loading next year's sheet — no code

**Paste a sheet…** takes the block straight out of their workbook:

```
COST              12       24       36       48       60
$5,000-9,999      .09590   .05016   .03514   .02769   .02324
$10,000-14,999    .09156   .04753   .03301   .02577   .02144
```

Tabs, commas or runs of two spaces all separate columns. The first press parses and
shows every band it read plus any term it treats as not offered; the second writes.
Tick _Publish it as soon as it loads_ to make it live, or leave it unpublished and
publish from the sheets list once you've checked it.

Individual cells are editable in the grid, and _Add a band_ / _Add a term_ extend it —
a 72-month term needs no migration.

## Decisions encoded

**Bands are half-open at the top.** The label reads `$15,000-24,999` and the workbook
tests `amount < 25000`, so $24,999.50 is in that band and $25,000.00 is in the next.
The editor takes the label's inclusive top and stores the exclusive bound.

**A blank cell means not offered.** The `$3,000–4,999` band has no 12- or 60-month
option — the workbook prints `.0000` there. No rate row is written, so the sheet shows
three terms rather than two at $0.00.

**Outside the table, quote the nearest band and say so.** Below $3,000 or above the top
band, the closest one is used and both the on-screen panel and the printed sheet carry
a marked estimate telling the customer to have Ryan Capital confirm. Refusing to quote
would send a rep to a spreadsheet nobody audits.

**The top band is open-ended.** Their sheet labels it $100,000–200,000, but its own
formula applies it to $500,000. Stored as `$100,000 and above` rather than inventing a
ceiling the sheet does not enforce.

**Overlaps are refused, not resolved.** Two bands covering one amount would make the
payment depend on sort order.

**Section 179 and the financed figure are unchanged** — the $1M cap at 21%, on the
proposal total, as you chose.

## Still open

The workbook's tax panel also shows 50% bonus depreciation and a $500K cap; the CRM
keeps its own $1M version, per your answer. Worth reconciling with your accountant at
some point, since the two documents disagree.

The `$50,000-75,000` and `$75,000-100,000` labels in the workbook overlap at exactly
$75,000 and $100,000. Stored as `$50,000-74,999` and `$75,000-99,999`, which is what
the formulas actually do.

# Financing Options sheet — two pages, brand colour, logo

## Files

| File                             | Role                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `src/handoff/brandLogo.ts`       | **New.** The logo as a base64 data URI, plus the `BRAND` palette       |
| `src/handoff/financeDocument.ts` | **Replace.** Two-page sheet; page 2 copy lives in `FINANCING_BENEFITS` |

Nothing else changes — the routes, the PDF renderer and the email attachment already
call `renderFinanceHtml`, so both the download and the send pick this up.

```
copy /Y fixes\src\handoff\brandLogo.ts src\handoff\brandLogo.ts
copy /Y fixes\src\handoff\financeDocument.ts src\handoff\financeDocument.ts
pnpm typecheck
```

Check it at `/proposals/<id>/financing.html` before pushing — that route renders the
same markup the PDF is made from, so the browser shows exactly what the customer gets.

## Why the logo is inlined

Every customer-facing document is rendered by headless Chromium from an HTML string
with no network access, which is what stops a dead asset URL from hanging a send. An
`<img src="/logo.png">` would print as a broken image. So the mark travels with the
markup as a data URI, downsampled to 240×240 — still oversampled for the sizes used
here, and a third of the original's weight. `BRAND` holds the two colours sampled from
the mark, `#203060` and `#d02030`, so the palette is the logo's rather than an
approximation of it.

## Colour

Colour points, it does not decorate. Navy carries the brand and every figure that
matters. The red appears exactly three times: the FINANCING label, the rule above the
featured term, and the benefit numerals. Everything else is neutral, and the only other
colour is the green on the tax saving, which was already there. A page where everything
is emphasised emphasises nothing, and a financing document that reads as a flyer is one
a finance committee discounts.

The middle term is filled navy — that is where most customers land, so it leads the row
instead of sitting unremarked among five identical cards.

## Two editorial decisions to check

**The one persuasive line** sits under the masthead: _"Open the space this year — and
let it start working while you pay for it."_ It answers the question a customer is
actually weighing, which is not whether to buy but whether to wait. Everything below it
is arithmetic. If you want it softer, it is one string near the top of
`renderFinanceHtml`.

**Your "Call to Action" and "Recommended Disclosure" labels are not printed.** The text
under them is, verbatim — the CTA as the navy band at the foot of page 2, the disclosure
as the fine print below it. Printing the labels themselves would read as an unfinished
draft. Say the word if you want them visible.

Page 2's benefit titles and bodies are your copy unchanged. They are numbered 01–08 in
`FINANCING_BENEFITS`; reorder or edit that array and the numbering follows.

## Also updated

`C. Kinsey` is now `Chandler Kinsey`, in one constant (`PARTNER`) used on both pages.

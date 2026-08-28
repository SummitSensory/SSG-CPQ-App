# Reporting, custom reports, and goals

Three things, one install.

1. **Signed deals** — monthly bars for the number of deals, a line for the dollars, across four milestones: accepted, order created, first payment received, paid in full.
2. **Report builder** — group by up to three of nineteen dimensions, filter on a dozen, pick the numbers, sort any column, download CSV, save the definition, have it emailed weekly or monthly.
3. **Goals** — a target per month, quarter or year, company-wide or per rep, in dollars, deals, product units, or any saved report's first number. Each one draws a pint glass that fills as the period progresses, with pace beside it.

## Install

Files are complete replacements or new files; copy each over the repo path it mirrors.

```
# 1. schema
prisma/schema.reporting.prisma          (new)
prisma/apply-reporting-schema.mjs       (new)

node prisma/apply-reporting-schema.mjs
npx prisma validate && npx prisma generate && npx prisma db push

# 2. server
src/reporting/dataset.ts                (new)
src/reporting/query.ts                  (new)
src/reporting/signedDeals.ts            (new)
src/reporting/goals.ts                  (new)
src/routes/insights.ts                  (new)
src/routes/cronInsights.ts              (new)
src/app.ts                              (replaces — registers the two above)
src/authz/permissions.ts                (replaces — adds goals:manage)

# 3. client
public/insights.js                      (new)
public/goals.js                         (new)
public/index.html                        (replaces — loads the two above)

# 4. schedule
vercel.json                             (replaces — adds /cron/scheduled-reports at 12:30 UTC)
```

Nothing existing changes behaviour. `app.ts` gains two registration calls, `permissions.ts` gains one permission, `index.html` gains two script tags, `vercel.json` gains one cron entry.

`preview/Insights Preview.html` renders both screens against canned data with no database — open it directly to see the chart and the glasses.

## Permissions

| Action                                         | Needs                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| See the chart, run and save reports, see goals | `proposal:read` — everyone already has it                               |
| Create, edit, retire or delete a goal          | `goals:manage` — new; granted to SYSTEM_ADMIN, EXECUTIVE, SALES_MANAGER |

Reading a goal is deliberately open: the point of a target on a wall is that everyone can see it.

## What the numbers mean

**Four milestones, four sources.** Accepted is the `ACCEPTED` status event on the proposal; ordered is the accepted order row; first payment and paid in full come from the QuickBooks payment mirror. A deal accepted in March and paid in May appears in March on the accepted view and in May on the paid view. The two gap figures under the chart ("accepted, no order yet" and "ordered, no payment yet") are as of today rather than filtered to the window, because a deal accepted in March with no order is still missing one.

**Money is never recomputed.** Every figure runs through `versionTotals()` in `proposals/analytics.ts`, which is what the printed proposal, the price snapshot and QuickBooks all agree with. Bundle child lines (the `—` rows under a priced bundle) are excluded from unit counts, the same way they are excluded from revenue.

**Product reports count per line.** Grouping by SKU, product, category, manufacturer, tier category or optional/included switches the report to line grain. In that mode "Proposals" counts the proposals that _contain_ the part and "Proposal value" is the value of those whole proposals — so the column exceeds the company total down the page, because one proposal carrying six parts is counted under all six. "Line value" is the per-part figure. The screen says this above the table whenever it applies.

**Goals read accepted proposals, dated by acceptance.** A sales goal is about closing, so it does not move when accounting raises or collects an invoice. Pace is the target times the fraction of the period elapsed; the glass shows the raw percentage and the caption shows whether that is ahead or behind.

## Scheduled reports

A saved report set to weekly or monthly emails itself from `/cron/scheduled-reports`, which Vercel calls daily at 12:30 UTC — after the receivables refresh, so payment milestones in a scheduled report are the refreshed ones.

- Weekly sends the completed seven days; monthly sends the completed calendar month. A schedule that reported "up to this morning" would make two consecutive emails incomparable.
- The email carries the table as HTML (first 200 rows) with the full result as a CSV attachment.
- It sends from the report owner's own Outlook mailbox, the same mechanism the payment-request letters use. An owner who has not connected Outlook cannot send, and the failure is written onto the report where the person who scheduled it will see it, not just into the log.
- Idempotent within a day: `lastSentAt` is checked first, so a double cron fire does not double-send.

## Performance

Every endpoint reads the world once through `buildDataset()` and caches it for sixty seconds per serverless instance. A session of tinkering in the builder therefore costs one database read, not one per keystroke. The cron forces a fresh read — a scheduled send must not report a figure that was true a minute before midnight on somebody else's page view.

## Examples the builder starts from

| Question                                                       | Definition                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| How many Summit Soar products went out on proposals over time? | Dated by created, group by month, show units + proposals + line value, product contains `soar`, included lines only |
| What has each rep signed this year?                            | Dated by accepted, from Jan 1, group by rep, show proposals + proposal value + margin %                             |
| What sells inside each tier category?                          | Group by tier category then product, show units + line value + proposals                                            |
| Where do we win?                                               | Dated by decided, group by customer type, show proposals + won + win rate + won value                               |

Each is one click under "Start from" in the builder, and any of them can be saved, scheduled, or turned into a goal.

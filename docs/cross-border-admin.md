# Cross-border administration

The Canadian pricing engine, its routes and the proposal rail all shipped before there
was anywhere to configure them. That meant the GST/HST registration every Canadian
proposal waits on, the FX fallback, the broker's fee tariff and the queue of proposals
sitting at `REQUIRES_CUSTOMS_REVIEW` were reachable only by SQL.

This adds the screen, the broker-fee arithmetic behind it, and the queue endpoint.

## Where it is

**Administration** → the _Canadian proposals and cross-border charges_ card, below the
existing panels. Six tabs, in the order the work happens:

| Tab                  | What it answers                                                 |
| -------------------- | --------------------------------------------------------------- |
| Readiness            | Why the feature cannot be switched on yet                       |
| Settings             | The switch, the FX fallback, the release gates                  |
| Tax registrations    | GST/HST first — one row unblocks every province                 |
| Tax rates            | Rates by province, and what each charge category is taxable for |
| Exchange rate        | What the Bank published; any manual override                    |
| Brokerage            | Fee schedules, and what each would charge                       |
| Customs review queue | Every Canadian proposal waiting on a decision                   |

Gated on `CROSSBORDER_MANAGE`, except the queue and the fee estimate, which take
`PROPOSAL_READ` so a rep can see their own job is waiting. A role without the
permission gets no card at all rather than a permission complaint.

## Files

| File                            | Why                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| `public/cross-border.js`        | The screen. Self-mounts on Administration, so `app.js` needs no edit |
| `src/crossborder/brokerFees.ts` | Fee arithmetic. Pure — no database, no clock                         |
| `src/routes/crossBorder.ts`     | Broker-fee CRUD, the estimate preview, the customs queue             |
| `src/routes/web.ts`             | `cross-border.js` added to `CLIENT_SCRIPTS`                          |
| `public/index.html`             | The `<script>` tag                                                   |
| `tests/unit/brokerFees.test.ts` | The fee table                                                        |

A client script is three things in one commit — the file, its route, and the tag. The
comment in `index.html` explains why: Vercel serves `public/` directly, so the Fastify
handler that would inject a tag never runs.

## Tax rates

The original design said rate corrections go by migration, and for a **seeded** rate
that is still the better route: a wrong rate misprices every Canadian job at once and
should leave a commit behind. A province with **no row at all** is a different
situation — the engine returns `no_rate_for_province`, the proposal cannot be quoted,
and waiting on a deploy to enter a figure published on the CRA's own site is a deploy
nobody should have to wait for.

So rates are enterable, with four things enforced:

1. **A source is required.** `readiness.unreviewedRateCount` reads that column to find
   the rows still waiting on an accountant, and a rate with no provenance cannot be
   checked later.
2. **No overlaps.** Two rows in force for the same province and tax type on the same
   date means the answer depends on row order. _Supersede_ is the way through: it
   closes the open row at the new row's start date, producing exactly the abutting
   pair the engine's **exclusive** `effectiveTo` expects. A gap or an overlap of one
   day misprices every proposal dated in it.
3. **One provincial sales tax per province, and never beside HST.** HST replaces the
   provincial line rather than sitting next to it, so mixing them would charge both.
   Manitoba is RST and Quebec is QST — two provincial rates in one province is not a
   jurisdiction that exists.
4. **A change is a new row; a correction is an edit.** Correcting in place restates
   what every proposal priced on that row was quoted, so the form says so and the
   audit records both figures.

The panel also lists the provinces with no rate in force, because that is the fact
that actually blocks a quote.

### What is taxable

On the same tab, for a reason: a rate with no taxability rule beside it charges nothing
and sends the proposal to review, so entering one without the other is half an answer.
A category with no rule does **not** default to taxable or exempt. `INSTALLATION`,
`DESIGN`, `TRAINING`, `TRAVEL` and `OTHER` ship unseeded on purpose — installation into
real property especially varies by province and needs a ruling.

Rules are additive only here. Closing one still goes by migration, because a closed
taxability rule changes what an issued proposal was calculated on.

## Broker fees

Brokerage is the one border charge that is genuinely knowable in advance: it comes off
the broker's own published tariff, not off a tariff classification this database does
not hold. So unlike duty, it can be computed.

It is still **not applied automatically.** `ProposalCustomsEntry.brokerFeeMinor` stays
a person's entry and needs the same approval as every other customs figure, for the
same reason — the number on a landed-cost quote should have a name against it. The
estimate exists so that person types a checked figure instead of doing arithmetic in a
browser tab.

Three things in the arithmetic that are worth stating, because none is obvious from
the column names:

1. **`percent` is a PERCENT, not a fraction.** `0.2500` is a quarter of one percent.
   Read as a fraction it would be a hundred times too large on every entry.
2. **A minimum or maximum bounds the broker's own fee**, then disbursement,
   advancement and bond are added. Those are amounts the broker advanced on the
   importer's behalf, not fees it set, so a floor must not be spent on them.
3. **A tier ceiling is inclusive, and a value above every tier refuses.** Charging the
   top band to a value beyond it would be a quiet guess. Exactly one tier may be
   open-ended; a table with two is ambiguous and rejected rather than resolved.

Rounding is half-up away from zero on `bigint`, the same rule `fx.ts` uses, so a fee
and a converted fee round the same direction.

`selectSchedule()` reads `effectiveTo` as **exclusive**, matching the tax and
registration tables, and prefers the schedule marked default. One default at a time is
enforced on write, so there is never a tie to break.

## The queue

`GET /cross-border/customs-queue` lists entries at `REQUIRES_CUSTOMS_REVIEW` or
`ESTIMATED`, oldest first, with the proposal number, customer and title resolved, plus
two derived facts: whether any figure has been entered, and whether a source reference
is on file. Those two are what `approveCustomsEntry()` checks, so the queue can say
why a row is not approvable without a second copy of the rule in the browser.

Approving still happens on the proposal. This screen is the list, not the workflow.

## What it does not do

- **No tier-table editor.** The form covers flat, percentage and per-unit schedules; a
  tiered tariff still needs its `tiers` JSON entered directly. The evaluator and the
  validator handle tiers fully, so the gap is the form only.
- **No rate deletion.** Rates and taxability rules can be added, superseded and
  corrected, never removed — an issued proposal's snapshot references the row it was
  priced on.
- **No exemption management.** `CustomerTaxExemption` has no screen yet.

## Before enabling

Unchanged from `docs/canadian-proposal-support.md` §7, and the Readiness tab now states
the first three in place:

1. Enter the federal GST/HST registration — fifteen characters, nine digits then `RT`
   and a four-digit account. Until it exists the settings route **refuses** to turn the
   feature on, rather than letting it be switched on and discovered one proposal at a
   time.
2. Confirm all thirteen provinces' rates with SSG's tax adviser. Nova Scotia's 14% HST
   and Saskatchewan's PST date are the two least certain.
3. Have the customs approach reviewed by SSG's broker.
4. Get a ruling on installation, design, training and travel — they have no taxability
   rows, so a Canadian job carrying any of them goes to review.

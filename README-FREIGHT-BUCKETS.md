# Freight, four buckets

Complete files under `fixes/`, mirroring the repo layout. Copy them over the
originals.

This replaces the three-bucket freight true-up. The old model had one job-level
"structure freight" box, one "standard freight" box, and per-line third-party freight,
and the entry screen showed an amount field with no indication of which job's
equipment it covered.

## What changed

**Four buckets, each with the source it actually comes from.**

| Bucket                                      | Source                          | Covers                                       |
| ------------------------------------------- | ------------------------------- | -------------------------------------------- |
| Steel freight                               | Read from the monday deal board | One job-level amount                         |
| Mats & padding freight                      | Read from the monday deal board | One job-level amount                         |
| Therapeutic equipment & accessories freight | Entered by hand                 | Chosen product items                         |
| Other freight                               | Entered by hand                 | The job, or chosen items, with a description |

Steel is what the schema calls `structureFreightMinor` and Other is what it calls
`stdFreightMinor` — the same money in the same fields, so amounts already recorded
under the old names read straight through with nothing to migrate.

**Steel and mats are read, not typed.** Both figures are quoted on the deal row by
the people who arrange the trucks, so this application reads them four ways: when the
freight panel opens, on a Refresh button, nightly for every outstanding job, and on
the board's own change webhook. All four converge on one upsert, so a figure that
arrives twice does not become two shipments. Typing one in by hand is possible and is
recorded as an override with a required reason — the board is what the freight desk
maintains, and a hand-typed figure that silently disagrees with it is the failure this
feature exists to prevent.

**Every screen says what is being shipped.** The item table is on all four buckets,
including the two whose amount is one job-level figure: whoever approves $4,250 of
steel freight should be able to see the structure it ships. For therapeutic and other
freight, the items are checkboxes — pick the ones a vendor quoted, enter the one
amount they quoted, and the split across them is shown live before it is saved
(pro-rata on extended price, largest remainder, computed identically on both sides so
the preview cannot disagree with the record).

**An invoice that is short of freight says so on every screen.** A red banner sits
above the whole application whenever an invoice exists and freight is either applied
and unbilled (the loud case — Summit decided to charge it and then did not) or still
outstanding. It can be dismissed, because the screen underneath has to be readable,
and it comes back the next day: an unbilled freight bill does not stop being one
because it was clicked away. It stops when the freight is billed or somebody records
that none applies.

**Freight reaches the invoice in instalments.** Each batch of applied freight is
billed when it lands rather than held until the last vendor answers — steel from the
fabricator this week, mats from Resilite a fortnight later. Nothing paid on the
invoice yet, the rows are appended and its total rises; a payment already applied, a
freight-only invoice is raised (`P-2026-0117-FRT`, then `-FRT2`, `-FRT3`). Each entry
reaches the invoice exactly once — pushing an already-billed figure is refused and
points at the credit-and-rebill path, because a second push charges the customer
twice.

**The mats freight tax is reported, never moved.** monday quotes it beside the mats
freight. It is tax on the signed document, and a freight true-up may not move tax, so
the panel states the figure and says it needs a new proposal version. Nobody has to go
looking for it and nothing silently changes it.

## Install

1. **Schema** — paste the two blocks from `prisma/schema.freight-trueup.prisma` into
   `prisma/schema.prisma` as its header describes, then `pnpm prisma generate`.
2. **Migration** — `prisma/migrations/0062_freight_buckets/migration.sql`. Additive
   only: three enums, one table, two nullable columns. Safe to apply ahead of the
   code. `pnpm prisma migrate deploy`.
3. **Server files** — copy over:
   - `src/proposals/freightTrueUp.ts` (replaces — four buckets, apportionment, guard)
   - `src/proposals/freightTrueUpService.ts` (replaces — entries, batches, alerts)
   - `src/integrations/monday/freightPull.ts` (new)
   - `src/integrations/quickbooks/freightInvoice.ts` (replaces)
   - `src/integrations/quickbooks/freightPush.ts` (replaces — repeatable, per batch)
   - `src/routes/freightTrueUp.ts` (replaces)
4. **Front end** — copy `public/freight-trueup.js`, and bump the cache-buster in
   `public/index.html`:

   ```html
   <script src="/freight-trueup.js?v=2"></script>
   <script src="/app.js?v=56"></script>
   ```

5. **Four hooks in `public/app.js`.** The module is self-contained; it borrows the
   shell's helpers rather than duplicating them.

   **(a) Next to the other one-time setup** — unchanged from before except that
   `mountBanner` is now called too:

   ```js
   if (window.FreightTrueUp) {
     window.FreightTrueUp.init({
       authed: authed,
       esc: esc,
       fmt0: fmt0,
       fmtDate: fmtDate,
       titleCase: titleCase,
       openModal: openModal,
       goToProposals: function (u) {
         activateNav('proposals');
         renderProposals(u);
       },
     });
     window.FreightTrueUp.mountBanner(user);
   }
   ```

   `mountBanner` creates its own `<div id="ftuBanner">` at the top of `<body>` if the
   page has not got one. Put an empty `<div id="ftuBanner"></div>` above the header in
   `index.html` if you would rather control where it sits.

   **(b) In `loadDashboard`**, where the attention list is assembled — unchanged:

   ```js
   var ftu = window.FreightTrueUp ? await window.FreightTrueUp.dashboardSection(user) : '';
   ```

   with `window.FreightTrueUp.bindDashboard(user)` after `box.innerHTML = …`.

   **(c) At the end of `openFreightReview`**, after `loadRfqPanel(true);` — unchanged:

   ```js
   if (window.FreightTrueUp) window.FreightTrueUp.mountPanel('ftuHost', p.id, v.id, user);
   ```

   **(d) The monday webhook.** In the existing board-change handler in
   `src/routes/webhooks.ts` (the one that already verifies monday's JWT), add one call
   for the deals board:

   ```js
   import { handleBoardChange } from '../integrations/monday/freightPull.js';
   // …inside the change_column_value branch, after the existing handling:
   if (boardId === env.MONDAY_DEALS_BOARD_ID) {
     await handleBoardChange(String(event.pulseId), 'system:webhook');
   }
   ```

   Verifying the signature stays the webhook plugin's job — duplicating it in the
   freight module would mean two places to get it wrong. `/freight/board-changed`
   exists as a CRON_SECRET-guarded equivalent for testing.

6. **The nightly sweep.** `POST /cron/freight-pull` with
   `Authorization: Bearer $CRON_SECRET`. On Vercel, in `vercel.json`:

   ```json
   { "crons": [{ "path": "/cron/freight-pull", "schedule": "0 9 * * *" }] }
   ```

   9am UTC is early morning Eastern — the figures are in before anyone opens the
   dashboard. It refuses outright when `CRON_SECRET` is unset.

7. **Environment** — nothing new is required. Optional, as before:

   ```
   ACCOUNTING_NOTIFY_EMAIL=accounting@summitsensory.com
   ```

8. **Tests** — `pnpm test`.

## Board columns

Read from the Deal Tracking board, primary first and the fallback used when the
primary is blank:

| Figure           | Primary            | Fallback          |
| ---------------- | ------------------ | ----------------- |
| Steel freight    | `formula_mky8s42a` | `lookup5__1`      |
| Mats freight     | `formula_mkzd3p9s` | `text_mkzdpjf2`   |
| Mats freight tax | `formula_mkzde17n` | — (reported only) |

Two ids per figure because the board holds each one twice: a formula column the
freight desk maintains and a lookup/text column the BOM already reads. Both are
fetched in one query. `GET /freight/monday-status` reports which columns this
deployment is reading and whether it is credentialled to read them.

## Decisions worth knowing

- **A zero counts as outstanding, not as an answer.** Nobody deliberately quotes $0 of
  steel freight. The cost of asking twice is a question; the cost of not asking is an
  unrecovered shipping bill. "No freight applies" is recorded explicitly, per bucket,
  with a reason — because "the mats ship freight-included" is a fact about the mats and
  says nothing about the steel.
- **Two amounts in one bucket are two shipments, not a correction.** Line-level
  amounts add to what a line already carries and job-level amounts sum. Treating the
  second quote as a replacement silently discarded money.
- **A board figure that disagrees with applied money is reported, never written.** Past
  the point where freight is on the proposal — possibly on a customer's invoice — a
  changed board value is a correction with money consequences. The panel says so and
  leaves it to a person.
- **The push is never automatic and always confirmed.** The preview reads QuickBooks
  live; the confirmed before/after totals go back with the push, and if the invoice
  moved in between nothing is sent.
- **A freight-only invoice is not the document the next batch goes on.** Appending to
  it would bury the second shipment inside the first shipment's invoice, so
  `invoiceForProposal` excludes supplements.
- **The customer is never emailed automatically.** An applied batch clears
  `customerNotifiedAt`, which shows as "customer not notified" until a rep sends the
  revised PDF and clears it.
- **The deposit is recomputed** on the new total, by the same function acceptance uses.
  If a deposit invoice already went out at the old figure, the order shows a higher
  deposit due than was billed — visible, not corrected for you.
- **The BOM gate is unchanged in kind, wider in reach.** A Bill of Materials cannot be
  sent or confirmed while any of the four buckets is unanswered and unexplained.
  Accepting, ordering and invoicing are still deliberately never blocked.

## Audit trail

`freight.trueup.open` / `.apply` / `.qbo_push` / `.qbo_push_failed` /
`.customer_notified`, `freight.entry.create` / `.update` / `.delete` /
`.not_applicable`, `freight.monday.pull`, `freight.alert.acknowledge`. Plus an
`OrderEvent` on the order and a `PriceOverrideLog` row per applied batch carrying the
vendor and quote reference that justified it.

## Not built

- Attaching the vendor's quote PDF is modelled (`quoteAttachmentId`) and accepted as
  an alternative to a quote reference, but wiring the upload widget into the panel is a
  separate slice.
- A daily email digest to the coordinator. The banner and the dashboard block are what
  is in.
- A top-level "Freight" nav item — still dashboard-and-proposal only.

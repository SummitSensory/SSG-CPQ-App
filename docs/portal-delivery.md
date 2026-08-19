# Portal → CRM: delivery details, freight ship-to, and colour selection

Stage 1 of the portal integration. The customer portal has no database — it reads
and writes monday, and the CRM is already subscribed to a signed monday webhook.
Nothing here adds infrastructure; it closes the return leg of a loop that already
runs one way.

Files: `prisma/schema.prisma`, `prisma/migrations/0057_portal_delivery`,
`prisma/schema.portal-delivery.prisma` (annotated reference),
`src/integrations/monday/portalDelivery.ts`,
`src/integrations/monday/webhookRegistration.ts`, `src/routes/integrations.ts`,
`src/routes/cron.ts`, `src/handoff/bomSections.ts`, `src/handoff/freightRfq.ts`,
`src/portal/colorSelection.ts`, `src/routes/portal.ts`, `src/config/env.ts`,
`src/app.ts`, `vercel.json`.

New environment variables: `CRON_SECRET` and `PUBLIC_BASE_URL` (both needed for the
automation in §3 and §6), and `ALERT_EMAIL` (§8). `PORTAL_COLOR_SELECTION` defaults
to `off`; `MONDAY_DELIVERY_BOARD_ID` and `PORTAL_BASE_URL` are optional.

---

## 8. Knowing when something breaks

Added after the `portalOrderItemId` outage, where the orders screen returned 500 on
every request and the only record was a log nobody was reading.

**What caused that outage.** Migration 0057 did not run, but the code that expects
its columns deployed. Prisma selects every column its client knows about, so one
missing column broke _every_ `acceptedOrder` query in the application — including
the orders list, which has nothing to do with delivery details. This is worth
internalising, because it means an unrun migration is never a small problem
confined to its own feature.

Three changes, in order of how much they matter:

**1. Migrations run in the build.** `vercel.json` runs `prisma migrate deploy`
between `generate` and `build`, so the schema can no longer lag the code it was
generated from. This is the actual fix; the other two are for the cases it cannot
cover — a migration applied to the wrong database, or a manual change to production.

**2. Unhandled faults are emailed.** `src/lib/alerts.ts`, wired into the existing
error handler. Set `ALERT_EMAIL` (comma-separated for several; falls back to
`BOM_BCC_EMAIL`). Requires `RESEND_API_KEY`, which is already set.

Three things keep it from becoming noise, because an alert people mute is worse than
no alert:

- Only genuine faults. A 4xx, a validation error, a QuickBooks reconnect prompt are
  all handled states and none of them alert.
- Deduplicated by fingerprint, one email per hour per distinct fault. A route broken
  for every request is one email, not four hundred.
- Fire-and-forget. Alerting never throws and never delays a response.

Common Prisma codes are translated into a title and a remedy rather than a stack
trace. `P2022` — the one from the outage — arrives as _"Database schema is behind the
deployed code"_ with `pnpm db:migrate:deploy` in the body.

**3. `GET /health/schema`.** Compares the database against the columns and tables
this build requires and returns **503** when it is behind, with the remedy in the
body. Also run at boot (alerting if it fails) and in the daily cron. Point an uptime
monitor at it — Better Stack, Pingdom, or Vercel's own monitoring — and the condition
is caught before anybody opens the affected screen.

When a migration adds a column the application cannot work without, add it to
`REQUIRED_COLUMNS` in `src/lib/schemaCheck.ts`. That list is what makes the check
meaningful.

> **What this does not cover.** A fault that never reaches the Fastify error handler
> — a build failure, a function timeout, a crash during startup — is not emailed by
> any of the above. Vercel emails you on failed deployments already; for the rest,
> the uptime monitor on `/health/schema` is the backstop, because a dead function
> fails that check by not answering at all.

---

## 1. What was decided

**The parking table is built, and the answer to "is the order always in the CRM
first?" is assumed to be no.** The invite is fired by a staff member setting a
status column on the manufacturing board; nothing in that act checks whether the
deal has been imported. An address that arrives early is held in
`PortalDeliverySubmission`, retried, and visible on the integrations screen. The
same table is the idempotency key against webhook redelivery, and the record of
what the customer actually said versus what reached the sheet.

**The portal's confirmed address becomes the freight RFQ ship-to when one exists.**
See §4 for what "RFQ ship-to" means, which is what you asked.

**Colour selection is built and switched off.** `PORTAL_COLOR_SELECTION=off` is
the default and refuses every endpoint. §5 is the parallel-run plan. The
administration objection is resolved — Bryan edits the Jotforms himself, so the
flexibility being traded away is his own.

**Templates live in the CRM — no second database.** §7, including what that costs
today, which is nothing.

**The manual steps are automated.** The monday subscriptions register themselves
(§3) and a daily cron retries everything waiting (§6).

---

## 2. One correction to the earlier recommendation

The design note said the chain was _submissions row → order item id →
`Opportunity.mondayItemId` → Proposal → AcceptedOrder_. Reading the boards, that
is wrong. The portal lives on the **Manufacturing Process** board (6533700776).
`Opportunity.mondayItemId` and `AcceptedOrder.mondayProjectId` are both **Deal
Tracking** ids. Different boards, different numbers, and no column relates them
today.

So the join is a ladder, and it parks rather than guesses:

1. `AcceptedOrder.portalOrderItemId` — a new column, exact, and the only rung used
   once an order has been matched even once.
2. The customer's email, which every submission carries. Exactly one live order
   under an organization with a contact at that address wins, and the link is
   written to rung 1 so nobody does it twice.
3. Anything else — no match, several candidates, no email — parks with the reason
   in words, and someone links it from the integrations screen.

Rung 2 is the rung to watch. If two of a customer's jobs are open at once it will
park, correctly, and want a human. If that turns out to be common, the cheap fix is
a monday Item ID column on the manufacturing board pointing at the deal row, which
would make rung 1 answer on the first submission for every order.

---

## 3. Turning delivery details on

> **Migrations must run before or with the deploy, not after.** Prisma selects every
> column its client knows about, so the moment code carrying
> `AcceptedOrder.portalOrderItemId` is live against a database without that column,
> _every_ `acceptedOrder` query fails — including the orders list, which has nothing
> to do with this feature. `vercel.json` now runs `prisma migrate deploy` in the
> build command for exactly this reason; before that change, a deploy without a
> manual migration run took the orders screen down with `P2022`.

1. Run migration 0057. Every change is additive; nothing existing is rewritten.
2. `pnpm db:generate`. The models and the new columns are already in
   `prisma/schema.prisma`; `schema.portal-delivery.prisma` is kept only as the
   annotated reference, matching `schema.esign.prisma` and `schema.vendor-colors.prisma`.
3. **Register the webhooks from the CRM**, rather than clicking through monday's
   settings panel:

   ```bash
   curl -X POST ".../integrations/monday/webhooks/sync?dryRun=true"   # report
   curl -X POST ".../integrations/monday/webhooks/sync"               # register
   curl ".../integrations/monday/webhooks"                            # verify: ready=true
   ```

   Needs `PUBLIC_BASE_URL` set (e.g. `https://crm.summitsensory.com`) so monday is
   given the right host — a preview deployment's own URL is not where production's
   subscriptions should point. Idempotent, so it is safe on every deploy, and the
   daily cron re-asserts it: a subscription deleted in monday by accident repairs
   itself within a day instead of silently swallowing every submission.

   Two subscriptions are created on the submissions board: `create_item` and
   `change_column_value`. Both are needed — the portal creates the row and _then_
   writes its ~30 columns one at a time, so the create event carries no address at
   all. Sync never deletes anything; webhooks pointing elsewhere are reported as
   `foreign` and removed by hand with `DELETE /integrations/monday/webhooks/:id`.

4. Set `CRON_SECRET` (any 16+ char random string) so the daily sweep can run. See §6.
5. Check Settings → Integrations → monday: `portalDelivery.configured` should be
   true and the board id should match.

**Why both subscriptions.** The portal creates the submissions row and then writes
its ~30 columns one at a time. The create event carries no address. Every event
re-reads the whole row; `PortalDeliverySubmission.mondayItemId` is unique, so the
29 events with nothing new to say cost one read each and return `unchanged`.

### What it does on a submission

Creates or updates one `ShipToAddress` per order, named
_Customer — confirmed by customer (SO-1234)_, marked `source = 'PORTAL'`, and
assigns it to every vendor section that is not `SUBMITTED`, along with the loading
dock, delivery timing and preferred date. A submitted section is never touched — a
vendor is holding a sheet printed from it — and the order owner is emailed instead,
with the new address and the vendors affected.

A resubmission updates the same address record in place, so a corrected ZIP follows
through to every section pointing at it, rather than leaving near-duplicates in
everyone's picker. The exception is a sent sheet: if a submitted section points at
that address, a second record is created instead and the frozen one is left alone.

Order timeline entries are written with actor `system:portal`. That is a sentinel,
not a user id, so it renders without a name on the order page — worth a small UI
case if it looks odd in practice.

### Operating it

|                                                                  |                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /integrations/monday/portal-delivery`                       | Every submission, newest first, with its status and reason |
| `POST /integrations/monday/portal-delivery/import/:itemId`       | Pull one submissions row by hand                           |
| `POST /integrations/monday/portal-delivery/:id/retry`            | Re-run a parked one after the order was imported           |
| `POST /integrations/monday/portal-delivery/:id/link` `{orderId}` | Attach a parked one to an order, and record the link       |
| `POST /integrations/monday/portal-delivery/retry-pending`        | Sweep everything waiting. Safe on a schedule               |
| `GET /integrations/monday/webhooks`                              | Which subscriptions exist, against which should            |
| `POST /integrations/monday/webhooks/sync`                        | Register whatever is missing. Idempotent                   |

Statuses: `INCOMPLETE` (columns still landing — normal for a few seconds),
`PARKED` (nowhere to put it yet), `APPLIED`, `CONFLICT` (every section already
submitted), `FAILED`.

The daily cron (§6) sweeps all three non-final states, so nothing waits on somebody
opening this screen.

---

## 4. The freight RFQ ship-to — what it means, and what changed

**What it is.** When an RFQ is raised, `shipToFor()` resolves an address and copies
it onto the `FreightRfq` row as seven frozen columns (`shipToName`, `shipToLine1`
…`shipToCountry`). Those columns print in the _Ship To_ block of the RFQ PDF the
vendor's freight desk quotes against, and they are frozen because the document a
vendor holds must never change under them. That block is the whole question "where
is this shipment going" — the carrier prices the lane from it.

**The bug.** It resolved from the organization record: shipping address, falling
back to billing. The organization record is the billing entity. On a job site with
a trailer, or a school district with a central office, that is the wrong building,
and freight quoted to the wrong city is wrong money.

**Now.** Three sources in order of trust — the address the customer confirmed in
the portal, the organization's shipping address, its billing address — and the one
used is recorded on the row as `shipToSource` and surfaced on the RFQ screen in
words: _"Billing address on the customer record — no shipping address on file"_.
Nothing about it prints on the vendor's document; it exists so the person sending
it can see the difference before they send.

**Timing, which matters more than it looks.** RFQs are raised at proposal time; the
portal invite goes out after the order exists. So in the ordinary sequence there is
no confirmed address yet and the RFQ falls back to the organization — same as
today, now labelled honestly. The portal address wins on re-quotes, on jobs quoted
late, and on any order whose freight is priced after delivery details come in.

**Revisions carry the old ship-to forward on purpose.** A revision corrects the
lines. Moving the shipment because a portal submission landed between revisions
would change what the vendor is quoting without anybody asking for it. Clear the
address on the screen to pick up the new one deliberately.

---

## 5. Colour selection — built, not switched on

`PORTAL_COLOR_SELECTION` has three settings, checked inside the service so no
future caller can route around them:

- **`off`** (default, and what production runs) — every endpoint refuses with a
  message saying so. The Jotform flow is untouched.
- **`shadow`** — a customer can be sent a link, and their picks are recorded
  against the order and stop there. Nothing reaches a procurement line.
- **`live`** — picks may be applied, by a person, from the order screen.

What it does better than the form: the customer can only choose colours the vendor
actually makes, because the list is the vendor's own palette; and the answer lands
on the procurement line the shop reads, with the vendor's code beside the name.
Applying is still a deliberate act by staff — a colour reaching a vendor sheet
without anyone here looking at it is a failure the Jotform flow already has, and
worth not reproducing.

What it does worse: **a non-developer cannot edit the question wording.** Palette
content is administered in the CRM, but the page and its copy are code. Bryan
administers the Jotforms himself, so this trade is between two things the same
person maintains — the flexibility being given up is his own, and he can edit
either. That removes the reason to keep Jotform. What remains to prove is only
whether the data is right, which is what the parallel run is for.

### The parallel run

Still worth doing once, but for correctness rather than for the administration
question, which is now answered.

Pick one live order with colour-bearing lines.

1. Set `PORTAL_COLOR_SELECTION=shadow`. Confirm `GET /portal/status` reports it.
2. Send the Jotform exactly as usual. Change nothing about the current process.
3. `POST /orders/:id/colors/request` and send the customer the returned link as
   well, saying plainly that it is a new version and the form still counts.
4. When both come back, compare `GET /orders/:id/colors` against the Jotform
   response, line by line.

It passes if: every line the shop needs a colour for was offered; the customer
could express what they wanted without emailing; and the two answers agree.

If it passes, set `live`, apply from the order screen, and keep Jotform running one
more order before retiring it. If a line the shop needs a colour for was _not_
offered, that is a missing colour spec on the product (Administration →
Manufacturers → Colours) rather than a fault in this code — fix the spec and re-mint
the link.

---

## 6. The daily sweep

`vercel.json` declares one cron: `POST /cron/portal-delivery` at 13:00 UTC (07:00
MT), which does two things.

1. **Retries everything waiting** — up to 50 submissions in `PARKED`, `INCOMPLETE`
   or `FAILED`. An address that arrived before its order gets picked up the morning
   after the order is imported, with nobody watching.
2. **Re-asserts the monday subscriptions.** Cheap and idempotent, and it means a
   webhook deleted in monday by accident repairs itself within a day rather than
   silently swallowing every submission until someone notices.

Authenticated on `CRON_SECRET`, which Vercel sends as a bearer token on its own
scheduled requests. **Unset, the endpoint refuses outright** — an open endpoint that
retries integration work is a way for anyone to hammer monday's API. Set it in
Vercel's environment variables for production and preview both.

It never returns 500. A failing cron endpoint is a Vercel alert with no reader; what
failed is in the response body and the logs, and the sweep runs again tomorrow.
Everything it calls is idempotent, so a double-fire is harmless.

Note for Hobby-plan limits: this is one cron, and daily is within them. If more
scheduled work is added later, add it to this endpoint rather than declaring a
second cron.

---

## 7. R7 — the portal's second database: decided, no second database

Templates live in the CRM. The reasoning below is kept because it is the argument
to re-read if anyone proposes a portal-side store later.

**What using the software today costs, given this decision: nothing.** That is the
point worth being clear about. The decision is a _decision not to build_ a second
store — there is no schema change, no migration, and no code in this changeset that
depends on it. Nothing about current operation changes, and no work already done is
wasted. What it buys is that when portal emails are built, they are built once, in
the place that already has the order.

The cost is deferred and small: portal email work will need a CRM endpoint to fetch
a rendered template or the order data behind it, which is a day of work at the time
rather than now. The alternative cost — migrating live templates out of a database
people are already writing to — is the one that is not small.

**Why.** A template in a separate database cannot reference order data. It can say
"your order has shipped"; it cannot say "your Soar frame ships Tuesday and the mats
follow on the 14th" without another integration hop to fetch the order, and that hop
goes back through monday, which is the brittleness this whole exercise is reducing.
The CRM already has follow-up template machinery (`src/email/followUpTemplates.ts`,
migration 0053) to build on.

**What was given up.** Deployment independence. A portal that renders an email from
CRM data has a new dependency on a system it currently does not touch, so a CRM
outage becomes a portal outage for that one path. Worth mitigating when the time
comes: cache the rendered template, or fail to a generic version, rather than
blocking the send.

**The rule to hold.** Templates live in exactly one place. The expensive outcome was
never either database — it is two, with the same template half-maintained in both.

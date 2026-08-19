# Portal → CRM: delivery details, freight ship-to, and colour selection

Stage 1 of the portal integration. The customer portal has no database — it reads
and writes monday, and the CRM is already subscribed to a signed monday webhook.
Nothing here adds infrastructure; it closes the return leg of a loop that already
runs one way.

Files: `prisma/schema.portal-delivery.prisma`, `prisma/migrations/0057_portal_delivery`,
`src/integrations/monday/portalDelivery.ts`, `src/routes/integrations.ts`,
`src/handoff/bomSections.ts`, `src/handoff/freightRfq.ts`, `src/portal/colorSelection.ts`,
`src/routes/portal.ts`, `src/config/env.ts`, `src/app.ts`.

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
the default and refuses every endpoint. §5 is the parallel-run plan that has to
pass before it moves.

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

1. Run migration 0057. Every change is additive; nothing existing is rewritten.
2. `pnpm db:generate`. The models and the new columns are already in
   `prisma/schema.prisma`; `schema.portal-delivery.prisma` is kept only as the
   annotated reference, matching `schema.esign.prisma` and `schema.vendor-colors.prisma`.
3. In monday: **Delivery & Site Details Submissions** board (18421779422) →
   Integrate → Webhooks → add two subscriptions to
   `https://crm.summitsensory.com/integrations/monday/webhook`:
   _when an item is created_ and _when a column changes_. The endpoint answers
   monday's `challenge` handshake already.
4. No new env var is needed. `MONDAY_DELIVERY_BOARD_ID` only exists in case that
   board is ever rebuilt.
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

Statuses: `INCOMPLETE` (columns still landing — normal for a few seconds),
`PARKED` (nowhere to put it yet), `APPLIED`, `CONFLICT` (every section already
submitted), `FAILED`.

Worth a daily cron on `retry-pending`; without one, a parked address waits for
somebody to open the screen.

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

What it does worse, which is the risk you flagged: **a non-developer can edit a
Jotform.** Palette content is administered in the CRM, but the question wording and
the page around it are code. Confirm who at Summit edits those forms today before
committing.

### The parallel run

Pick one live order with colour-bearing lines.

1. Set `PORTAL_COLOR_SELECTION=shadow`. Confirm `GET /portal/status` reports it.
2. Send the Jotform exactly as usual. Change nothing about the current process.
3. `POST /orders/:id/colors/request` and send the customer the returned link as
   well, saying plainly that it is a new version and the form still counts.
4. When both come back, compare `GET /orders/:id/colors` against the Jotform
   response, line by line.

It passes if: every line the shop needs a colour for was offered; the customer
could express what they wanted without emailing; the two answers agree; and the
person who administers Jotform today can administer the palettes.

If it passes, set `live`, apply from the order screen, and keep Jotform running
one more order before retiring it. If it fails on the administration point rather
than the data, that is an argument for keeping Jotform, not for fixing the code.

---

## 6. R7 — the portal's second database

You asked for help rather than an answer, so here is the shape of it.

**The decision is yours, and it has to be made before the portal provisions
anything.** Not because a Postgres is expensive, but because unwinding one later
means migrating live templates out of a database people are already writing to.
This is cheap now and annoying in three months.

**What the portal actually needs a database for.** Email templates, and the state
that goes with them — which template, which version, when it was sent, to whom.

**The argument against a second one.** A template in a separate database cannot
reference order data. It can say "your order has shipped"; it cannot say "your Soar
frame ships Tuesday and the mats follow on the 14th" without another integration
hop to fetch the order — and that hop goes back through monday, which is the
brittleness this whole exercise is trying to reduce. Templates in the CRM have the
order sitting right there, and the CRM already has the follow-up template
machinery (`src/email/followUpTemplates.ts`, migration 0053) to build on.

**The argument for.** Deployment independence. The portal ships on its own
schedule, and a portal that needs the CRM up to render an email has a new
dependency on a system it currently does not touch. If the templates are genuinely
generic — "here is your invite", "here is your link" — that independence is worth
something and the data poverty costs nothing.

**How to decide it in one question.** Will any portal email ever need to say
something specific about the order — a part, a ship date, a vendor, a figure?

- If yes: put the templates in the CRM, and give the portal a read endpoint. The
  second database is a wall you will spend a year passing data over.
- If no, and they stay generic: a small portal-side store is fine, and you keep the
  deploy independence.

My read is that it is yes, because the portal's whole purpose is telling a customer
about their specific order — but that is a product question about what those emails
will say, and you know that better than the code does.

**Whichever way it goes, one rule: templates live in exactly one place.** The
expensive outcome is not either database. It is two, with the same template
half-maintained in both.

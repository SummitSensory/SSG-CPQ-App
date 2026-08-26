# Freight true-up — adding freight after the proposal has gone out

Everything below is complete files under `fixes/`, mirroring the repo layout. Copy
them over the originals.

## What it does

**A frozen proposal can now take freight, and nothing else.** A released or accepted
version keeps its number, its version, its line items and its signature. The freight
fields unlock through one form; the amendment refuses to save if the subtotal, the
discount, the tax or mats freight moved by so much as a cent (`assertFreightOnlyChange`).
Applying it re-freezes the price snapshot and rebuilds the operational order's content
snapshot and integrity hash, so QuickBooks pushes and `verifyIntegrity` keep working —
without that step every later document build would fail its total assertion.

**Freight reaches an invoice that already exists.** Nothing paid → the freight rows are
appended to the existing QuickBooks invoice and its total rises. Payments applied → a
freight-only invoice `P-2026-0117-FRT` is raised instead, recorded as an ordinary
invoice transaction so it appears in the job's billing list and syncs its own payments.
The decision is made from QuickBooks' own payment state, read live, not from our copy.

**It is hard to forget.** A dashboard block lists every job with freight outstanding,
oldest first, with the age in days — amber at 3, red at 5. A Bill of Materials cannot
be sent or confirmed to a vendor while freight is unquoted and unexplained
(`plugins/freightGate.ts`). Accepting the proposal, creating the order and raising the
invoice are deliberately **not** blocked: those are the steps that get manufacturing
moving, which is the whole point.

**The freight coordinator has her own way in.** `FREIGHT_COST_WRITE` on the OPERATIONS
role: the queue, per-line and per-bucket entry, vendor name and quote reference,
"no freight applies" with a reason, and — via `FREIGHT_INVOICE_PUSH`, also on
OPERATIONS — the push to QuickBooks herself. She gets no proposal editing, no release,
no margins. An amount cannot be saved without a quote reference or an attached quote.

## Install

1. **Schema** — paste the two blocks from `prisma/schema.freight-trueup.prisma` into
   `prisma/schema.prisma` as its header describes, then `pnpm prisma generate`.
2. **Migration** — `prisma/migrations/0045_freight_trueup/migration.sql` is written.
   Additive only (one table, two enums, no alters), so it is safe to apply ahead of the
   code: `pnpm prisma migrate deploy`.
3. **Server files** — copy over:
   - `src/proposals/freightTrueUp.ts` (new, pure)
   - `src/proposals/freightTrueUpService.ts` (new)
   - `src/integrations/quickbooks/freightInvoice.ts` (new, pure)
   - `src/integrations/quickbooks/freightPush.ts` (new)
   - `src/routes/freightTrueUp.ts` (new)
   - `src/plugins/freightGate.ts` (new)
   - `src/authz/permissions.ts` (replaces — two new permissions, new grants)
   - `src/app.ts` (replaces — registers the routes and the gate)
4. **Front end** — copy `public/freight-trueup.js`, then in `public/index.html` load it
   **before** `app.js` and bump the cache-buster:

   ```html
   <script src="/freight-trueup.js?v=1"></script>
   <script src="/app.js?v=55"></script>
   ```

5. **Three hooks in `public/app.js`.** The module is self-contained; it borrows the
   shell's helpers rather than duplicating them, so it needs to be handed them once and
   called in two places.

   **(a) After the helper functions are defined — anywhere inside the main closure,
   next to the other one-time setup:**

   ```js
   // Freight true-up lives in its own file; hand it the shell's helpers once.
   if (window.FreightTrueUp)
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
   ```

   **(b) In `loadDashboard`, where the attention list is assembled** — replace the
   existing `freightAlertGroup(freightRows) +` line with the true-up section, which
   supersedes it (it reports the same jobs plus the ones already part-answered, with
   age and entry state):

   ```js
   var ftu = window.FreightTrueUp ? await window.FreightTrueUp.dashboardSection(user) : '';
   var box = document.getElementById('dashAttention');
   var html = ftu +
     followUpGroup(followRows) +
     attnGroup('Past expiration', data.expiredOpen, '#9c3327', 're-date or mark inactive') +
     ...
   box.innerHTML = html || '<div class="placeholder" ...>';
   if (window.FreightTrueUp) window.FreightTrueUp.bindDashboard(user);
   ```

   `freightAlertGroup` and `.freightRow` can stay in place — nothing calls them once
   this is in, and leaving them makes the change trivially reversible.

   **(c) At the end of `openFreightReview`**, after `loadRfqPanel(true);`, so the
   entry form sits under the RFQ rail on the screen the dashboard already opens:

   ```js
   if (window.FreightTrueUp) window.FreightTrueUp.mountPanel('frFreight', p.id, v.id, user);
   ```

   (That replaces the contents of the `#frFreight` card with the live freight panel. To
   keep the RFQ rail as well, give the panel its own container: add
   `'<div id="ftuHost"></div>'` after the `#frFreight` div in that template and mount
   into `'ftuHost'` instead.)

6. **Environment** — optional, for the "email Accounting when the total changes" guard:

   ```
   ACCOUNTING_NOTIFY_EMAIL=accounting@summitsensory.com
   ```

   Comma-separated for several recipients. Unset means no email is sent and the push
   records that nobody was notified. It is read from `process.env` directly, so
   `src/config/env.ts` needs no change.

7. **Tests** — `tests/unit/freight-trueup.test.ts` (new). `pnpm test`.

## Decisions worth knowing

- **The customer is never emailed automatically.** An applied true-up clears
  `customerNotifiedAt`, which shows as "Customer not notified" on the proposal until a
  rep sends the revised PDF and clears it. You left that question unanswered, so this is
  the middle option: nothing goes out on its own, but the omission stays visible.
- **The deposit is recomputed.** Re-freezing uses `snapshotAcceptedContent`, the same
  function acceptance uses, so the deposit is the configured percentage of the _new_
  total. If a deposit invoice has already gone out at the old figure, the deposit due on
  the order will now be higher than the one billed — visible on the order, not corrected
  automatically.
- **Third-party freight is per line**, matching how the builder and the vendors work
  (Southpaw quotes shipping on its own parts). Structure and standard freight are single
  job-level amounts.
- **Mats freight and the freight-tax pass-through are out of scope** — you did not list
  them as usually-missing, and a true-up that could reach every money field would be a
  price editor with a freight label on it.
- **Amend vs supplement is decided by payment state, not by the user.** Raising the
  total of an invoice a customer has partly paid breaks their remittance.
- **Every push is confirmed against live figures.** The preview reads QuickBooks and the
  confirmed before/after totals are sent back with the push; if the invoice moved in
  between, nothing is sent and the new numbers are shown.
- **Audit trail**: `freight.trueup.open` / `.stage` / `.apply` / `.no_freight` /
  `.qbo_push` / `.qbo_push_failed` / `.customer_notified` in the audit log, an
  `OrderEvent` on the order, and a `PriceOverrideLog` row carrying the vendor and quote
  reference that justified the change.

## Not built (say the word)

- Daily email digest to the coordinator and rep, and escalation to the Sales Manager at
  5 days — you left both out of the reminder set; the dashboard block and the BOM gate
  are what is in.
- Attaching the vendor's quote PDF is modelled (`quoteAttachmentId`) and enforced as an
  alternative to a quote reference, but wiring the upload widget into the freight panel
  is a separate slice.
- A top-level "Freight" nav item — you chose dashboard-only.

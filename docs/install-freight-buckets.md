# Install — freight, four buckets

Every step in order, with the exact commands. Nothing here needs a decision; where
there is a choice it is called out.

Assumes you are at the repo root of `SummitSensory/SSG-CPQ-App` with `pnpm` installed
and the correct `DATABASE_URL` in your shell or `.env`.

---

## 0. Branch

Do this on `qbo-sandbox` first — it exercises the QuickBooks push, and the push is the
part that changes what a customer owes.

```bash
git checkout qbo-sandbox
git pull
git checkout -b freight-four-buckets
```

---

## 1. Copy the files in

Ten files. `fixes/` mirrors the repo layout, so each one goes to the same path with
`fixes/` stripped.

```bash
# server — replaces
cp fixes/src/proposals/freightTrueUp.ts                    src/proposals/freightTrueUp.ts
cp fixes/src/proposals/freightTrueUpService.ts             src/proposals/freightTrueUpService.ts
cp fixes/src/integrations/quickbooks/freightInvoice.ts     src/integrations/quickbooks/freightInvoice.ts
cp fixes/src/integrations/quickbooks/freightPush.ts        src/integrations/quickbooks/freightPush.ts
cp fixes/src/routes/freightTrueUp.ts                       src/routes/freightTrueUp.ts

# server — new
cp fixes/src/integrations/monday/freightPull.ts            src/integrations/monday/freightPull.ts

# front end — replaces
cp fixes/public/freight-trueup.js                          public/freight-trueup.js

# tests — the old file tested the removed three-bucket API
cp fixes/tests/unit/freight-buckets.test.ts                tests/unit/freight-buckets.test.ts
rm -f tests/unit/freight-trueup.test.ts

# migration
mkdir -p prisma/migrations/0046_freight_buckets
cp fixes/prisma/migrations/0046_freight_buckets/migration.sql \
   prisma/migrations/0046_freight_buckets/migration.sql
```

---

## 2. Schema

`fixes/prisma/schema.freight-trueup.prisma` is not loaded by Prisma — it is a paste
source. Open it alongside `prisma/schema.prisma` and do two things.

**2a.** Inside `model Proposal`, directly after the `freightRfqs FreightRfq[]` line,
the relation list now needs both:

```prisma
  freightTrueUps FreightTrueUp[]
  freightEntries FreightEntry[]
```

(`freightTrueUps` is probably already there from the last install. Add
`freightEntries` next to it.)

**2b.** Replace the existing `model FreightTrueUp` block at the end of
`prisma/schema.prisma` with everything below the second divider in the fixes file —
that is the updated `FreightTrueUp` (two new columns), the new `FreightEntry` model,
and four new enums (`FreightBucketKind`, `FreightEntrySource`, `FreightEntryScope`,
`FreightEntryStatus`). `FreightTrueUpStatus` and `FreightInvoiceMode` are unchanged;
leave the ones you have.

Then:

```bash
pnpm prisma generate
```

---

## 3. Migration 46

The SQL is additive only — four enums, one table, two nullable columns, no drops or
alters — so it is safe to apply before the code ships.

**Check what is already applied:**

```bash
pnpm prisma migrate status
```

You should see `0045_freight_trueup` applied and `0046_freight_buckets` pending.

**Apply it:**

```bash
pnpm prisma migrate deploy
```

`migrate deploy` is the right command here, not `migrate dev` — `dev` may offer to
reset the database, which on a preview branch pointed at a shared database would be a
very bad afternoon.

**Verify the table landed:**

```bash
pnpm prisma db execute --stdin <<'SQL'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'FreightEntry'
ORDER BY ordinal_position;
SQL
```

Expect 28 rows, starting `id`, `trueUpId`, `proposalId`, `versionId`, `bucket`.

**And the two new columns on the folder:**

```bash
pnpm prisma db execute --stdin <<'SQL'
SELECT column_name FROM information_schema.columns
WHERE table_name = 'FreightTrueUp' AND column_name IN ('alertAckAt', 'alertAckById');
SQL
```

Expect both.

**If `migrate deploy` reports a failed migration** (usually because a partial apply
was interrupted), the SQL is written so re-running is safe — every statement is
`IF NOT EXISTS` or wrapped in a duplicate-object guard. Resolve and retry:

```bash
pnpm prisma migrate resolve --rolled-back 0046_freight_buckets
pnpm prisma migrate deploy
```

**Production**, when you are ready: Vercel runs the migration on deploy if that is how
`0045` went out. If you apply it by hand, point `DATABASE_URL` at production and run
`pnpm prisma migrate deploy` — nothing else. Do not run `generate` against production.

---

## 4. `public/index.html`

Bump the cache-buster so browsers actually take the new file:

```html
<script src="/freight-trueup.js?v=2"></script>
<script src="/app.js?v=56"></script>
```

Optionally give the banner a fixed home — put this immediately inside `<body>`, above
the header:

```html
<div id="ftuBanner"></div>
```

If you skip it, `mountBanner` creates the div itself as the first child of `<body>`.

---

## 5. Four hooks in `public/app.js`

Three of these you already have from the last install. Only **(a)** changes, by one
line.

### (a) One-time setup — add `mountBanner`

Find the existing `window.FreightTrueUp.init({…})` call and make the whole block read:

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

`mountBanner` needs `user` in scope — it uses the role to decide whether the dismiss
button appears. If your `init` call sits somewhere `user` is not available, move just
the `mountBanner(user)` line to wherever the session is known (next to the first
`activateNav` call is fine).

### (b) The dashboard block — unchanged

In `loadDashboard`, where the attention list is assembled:

```js
var ftu = window.FreightTrueUp ? await window.FreightTrueUp.dashboardSection(user) : '';
var box = document.getElementById('dashAttention');
box.innerHTML = ftu + followUpGroup(followRows) + /* …the rest… */ '';
bindFolds();
if (window.FreightTrueUp) window.FreightTrueUp.bindDashboard(user);
```

### (c) The freight review screen — unchanged

At the end of `openFreightReview`, after `loadRfqPanel(true);`:

```js
if (window.FreightTrueUp) window.FreightTrueUp.mountPanel('ftuHost', p.id, v.id, user);
```

That needs `<div id="ftuHost"></div>` in the freight review template, after the
`#frFreight` card. If you mounted into `'frFreight'` last time, either add the host div
or keep passing `'frFreight'` — the panel replaces whatever container it is given.

### (d) The monday webhook — new

In the existing board-change handler in `src/routes/webhooks.ts` (the one that already
verifies monday's JWT), inside the `change_column_value` branch:

```ts
import { handleBoardChange } from '../integrations/monday/freightPull.js';

// …after the existing handling for this event:
if (String(boardId) === env.MONDAY_DEALS_BOARD_ID) {
  await handleBoardChange(String(event.pulseId), 'system:webhook');
}
```

Signature verification stays where it is. Duplicating it inside the freight module
would mean two places to get it wrong.

---

## 6. The nightly sweep

In `vercel.json`, add the cron (or extend the existing `crons` array):

```json
{
  "crons": [{ "path": "/cron/freight-pull", "schedule": "0 9 * * *" }]
}
```

9am UTC is early morning Eastern, so Friday-afternoon board entries are in before
anyone opens the dashboard on Monday. The endpoint requires
`Authorization: Bearer $CRON_SECRET` and returns 503 if `CRON_SECRET` is unset, so
confirm it is set on the deployment:

```bash
vercel env ls | grep CRON_SECRET
```

Test it by hand:

```bash
curl -s -X POST "$BASE_URL/cron/freight-pull?limit=5" \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expect `{"scanned":N,"updated":N,"conflicts":0,"failed":[]}`.

---

## 7. Build and test

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` should show `tests/unit/freight-buckets.test.ts` passing. If typecheck
complains about `FreightEntry` not existing on `prisma`, step 2 did not take — re-run
`pnpm prisma generate`.

---

## 8. Environment

Nothing new is required. Optional, unchanged:

```
ACCOUNTING_NOTIFY_EMAIL=accounting@summitsensory.com
```

Confirm the board read is credentialled:

```bash
curl -s "$BASE_URL/freight/monday-status" -H "Authorization: Bearer $TOKEN" | jq
```

`configured: true` plus the five column ids. `configured: false` means
`MONDAY_API_TOKEN` or `MONDAY_DEALS_BOARD_ID` is missing — the panel still opens, and
steel and mats fall back to hand entry with a reason.

---

## 9. Smoke test on sandbox

In this order, on a job that already has an invoice:

1. Open the freight panel. Four bucket cards, the item table, and a "deal board read
   just now" line.
2. **Steel** — hit _Refresh from the board_. If the column is populated the figure
   appears as an entry. If not, use _Enter it by hand instead_ and confirm it refuses
   to save without a reason.
3. **Therapeutic** — tick two items, enter one amount, watch the split appear against
   each item, and confirm it refuses to save without a quote reference.
4. **Other** — job-level, and confirm it refuses to save without a description.
5. **Mats** — record _no mats freight applies_ with a reason, and confirm the card
   goes grey and the bucket stops being counted as outstanding.
6. _Apply to the proposal_. Check the proposal total moved by exactly the sum, and that
   the red banner at the top of the screen now says the invoice is short.
7. _Add to the invoice_. Read the preview, confirm the before/after, send. Check
   QuickBooks: appended rows if nothing was paid, `-FRT` invoice if something was.
8. Enter one more amount, apply it, bill it. Confirm it becomes a second push and that
   re-pushing the first batch is refused with the credit-and-rebill message.
9. Dismiss the banner. Confirm it disappears and that `GET /freight/alerts?all=1`
   still lists the job.

---

## 10. Ship

```bash
git add -A
git commit -m "Freight: four buckets, board-sourced steel and mats, per-item entry, invoice-short alert"
git push -u origin freight-four-buckets
```

Open the PR against `qbo-sandbox` for the preview deployment, exercise step 9 there,
then merge forward to `main`.

# Why the Remedy address never appeared — the actual root cause

## What the CRM knows

One submission has ever reached the CRM:

```
Hearing and Speech Connection — SO-2026-000006
monday item 12847063035 · received 2026-08-19 18:53 · APPLIED · 5 sections
```

The board has dozens of rows going back weeks, including
`Remedy Speech Therapy — 8/14/2026` and `Kalen Siddens — 8/13/2026`.

## Why

**Webhooks are not retroactive.** The CRM subscribed to the Delivery & Site Details
Submissions board on 19 August. A monday webhook fires on events from that moment
on; it does not replay the board's history. Every submission made before the
subscription existed — Remedy on the 14th, Kalen on the 13th, and everything above
them — never produced an event, so the CRM has no record of them at all.

That is why `retry-pending` returned `checked: 0`. The retry sweep looks at
`PortalDeliverySubmission` rows that are PARKED / INCOMPLETE / FAILED. Remedy isn't
stuck in the CRM; it was never in the CRM.

The blank `Address Line 1` on that row is a second, real problem — it would have
stopped the address at the `isUsable` gate even if the webhook had fired. Both
fixes are needed, and both are now in `fixes/`.

## The fix

`backfillFromBoard()` in `src/integrations/monday/portalDelivery.ts`, exposed as:

```
POST /integrations/monday/portal-delivery/backfill?max=200
```

It reads the board directly with `fetchAllItems`, and puts every row that carries an
address through the ordinary ingest — same code path as a webhook, same idempotency.
Rows with no address at all (an invite row nobody has filled in) are skipped rather
than stored as permanently INCOMPLETE. Already-APPLIED rows return `unchanged`.

Combined with the formatted-address salvage, Remedy resolves: the backfill brings
the row in, the salvage reads `901 N Washington St` out of the formatted column, and
the address lands on SO-2026-000011's vendor sections.

## What is still missing

There is no UI for any of this. `listSubmissions`, retry, link-to-order, backfill and
webhook status are all API-only — nothing in `public/app.js` renders them. Every
diagnosis in this thread had to be done from the browser console, which is also why
each problem was only visible after the one in front of it was cleared:

1. The picker showed nothing → looked like a picker bug.
2. The board row had no street → looked like the whole cause.
3. `retry-pending` found nothing → revealed the row was never ingested.
4. The submissions list showed one row from one day → revealed the webhook gap.

A submissions panel under Settings → Integrations showing status, the reason a row is
stuck, and buttons for retry / link / backfill would have made all four visible on
one screen in one look.

## The financing 404

`GET /proposals/:id/financing` returning 404 is not a fault. `financeDocFor` throws
`NotFoundError` when a proposal has no version with a frozen price snapshot, and the
UI already handles it — the Financing panel reads "No released version to quote from
yet." The console line is the browser reporting the status code, nothing more.

# Installing the portal delivery panel

Four files change. Two are complete replacements from `fixes/`; two are one-line
edits, because `public/app.js` is 13,000 lines and `public/index.html` carries two
inline base64 logos — shipping either as a whole file would be 40 KB of noise around
a single line, and a bad diff to review.

## 1. Copy these over

| From the zip                                | To                                          |
| ------------------------------------------- | ------------------------------------------- |
| `public/portal-delivery.js`                 | `public/portal-delivery.js` (new file)      |
| `src/integrations/monday/portalDelivery.ts` | `src/integrations/monday/portalDelivery.ts` |
| `src/routes/integrations.ts`                | `src/routes/integrations.ts`                |

`portalDelivery.ts` in the zip now also carries the tightened backfill filter (a row
needs a street or a formatted address to be stored at all), the point of contact on
the list, and `purgeAddresslessIncomplete()`. `integrations.ts` exposes the backfill
and the purge.

## 2. `public/index.html` — load the panel

Find, near the bottom:

```html
<script src="/vendor-colors.js?v=1"></script>
<script src="/app.js?v=61"></script>
```

Replace with:

```html
<script src="/vendor-colors.js?v=1"></script>
<script src="/portal-delivery.js?v=1"></script>
<script src="/app.js?v=62"></script>
```

The panel must load before `app.js`, and the `v=62` bump is what stops browsers
serving the cached `app.js` that has no mount call in it.

## 3. `public/app.js` — mount it

In `renderIntegrations`, the view is built from one `view.innerHTML = …`. Find the
end of that assignment:

```js
'<div class="placeholder"><h3>What connecting does</h3><p>Sends you to Intuit to approve access, then stores an encrypted token. ' +
  'In the ' +
  esc(envLabel.toLowerCase()) +
  ' environment nothing touches your real books.</p></div>';
```

Add the mount point and the call directly after it — so the two lines below go
between that statement and `var btn = document.getElementById('qboConnect');`:

```js
'<div class="placeholder"><h3>What connecting does</h3><p>Sends you to Intuit to approve access, then stores an encrypted token. ' +
  'In the ' +
  esc(envLabel.toLowerCase()) +
  ' environment nothing touches your real books.</p></div>' +
  '<div id="portalDeliveryPanel"></div>';

// The portal delivery panel lives in its own file; app.js only says where it goes.
if (window.SSGPortalDelivery) {
  window.SSGPortalDelivery.mount(document.getElementById('portalDeliveryPanel'), {
    authed: authed,
  });
}
```

Note the `;` moves from the `</div>` line onto the new `<div id="portalDeliveryPanel">`
line. That is the whole edit — if `SSGPortalDelivery` fails to load for any reason the
Integrations screen renders exactly as it does today.

## 4. Push and check

```
pnpm typecheck
pnpm test
git add -A
git commit -m "portal delivery: operational panel, purge endpoint, tighter backfill filter"
git push origin main
```

Then, on `crm.summitsensory.com` → **Administration → Integrations**, below the
QuickBooks card:

- every submission, worst status first, with the reason it is stuck in plain words;
- **Backfill from board**, **Retry everything pending**, per-row **Retry**;
- an order dropdown and **Link** on any stuck row — the console procedure from this
  thread, as two clicks;
- **Clear N address-less row(s)**, shown only when there are any;
- a `parsed` badge on any address whose street was read out of the formatted line, and
  a `changed` badge where the customer altered the address on file;
- a link straight to the monday row.

Applied rows are collapsed behind a **Show** toggle — the screen's job is what needs
attention.

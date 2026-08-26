# Portal: send the address as fields, not only as one line

## The actual cause (found in the code, 20 Aug)

`lib/monday.js` → `createDeliverySubmissionItem()` was not the problem. It already
writes all seven address columns unconditionally, empty strings included.

The problem is one branch in `pages/portal/index.js` → `DeliveryTab.submit()`:

```js
addressLine1:  addressConfirmed === false ? addressLine1 : '',
addressLine2:  addressConfirmed === false ? addressLine2 : '',
addressCity:   addressConfirmed === false ? addressCity : '',
addressState:  addressConfirmed === false ? addressState : '',
addressZip:    addressConfirmed === false ? addressZip : '',
addressCountry: addressConfirmed === false ? addressCountry : '',
```

and, just above it:

```js
const formattedAddress = addressConfirmed === false
  ? [addressLine1, addressLine2, addressCity, …].join(', ')
  : billingAddressOnFile;
```

So when a customer **confirms** the address already on file — the common case, one
radio button — the portal sends all six discrete fields as empty strings and puts the
address only in the joined `formattedAddress` line. Only a customer who answers "no,
that address is wrong" and retypes it fills the columns.

That is exactly what the board shows. `Remedy Speech Therapy — 8/14/2026` and
`Kalen Siddens — 8/13/2026` have a full street in **Full Ship-To Address Formatted**
and nothing in **Address Line 1**. Both customers confirmed rather than retyped.

The CRM requires a street and a city before it will put an address on a vendor sheet,
so those submissions sat INCOMPLETE and never reached a purchase order.

## The fix

`fixes/pages/portal/index.js` — one file, three changes, all inside `DeliveryTab`:

1. **`shipToParts()`** returns the ship-to as six fields whichever way the customer
   answered. Typed answers come from the form. A confirmed on-file address comes from
   `order.billingSnapshot`'s own components (`billingAddress`, `billingAddressSuite`,
   `billingCity`, `billingState`, `billingZip`, `billingCountry` — already written by
   the billing tab), and only if no snapshot exists is the combined string parsed.

2. **`parseCombinedAddress()`**, a module-level fallback parser. `billingAddressOnFile`
   is one string by design (see `BillingTab`'s own comment), so for an older order with
   no billing snapshot this is the only way to recover the components. It reads the tail
   inward — country, then state/ZIP, then city — and treats the rest as the street,
   returning blanks rather than guessing.

3. **The six fields and the formatted line are now built from that one object**, so they
   cannot disagree about where the truck goes, and the fields are never blanked.

Nothing changes in `lib/monday.js`, and nothing in `pages/api/portal/setup.js` — that
handler already passes these fields straight through to both the snapshot and the
submissions board.

## Worth knowing

- `deliverySnapshot` will now store the address components on a confirm-only
  submission too. That is an improvement: if the customer later answers "no, it's
  wrong", the form opens prefilled with the address on file instead of blank.
- `COLS.address` (Confirmed Delivery Address on the order) is still only written when
  `addressConfirmed === false`. Correct — confirming means it did not change.
- The CRM-side salvage stays in place as a backstop. Once this ships, new submissions
  should appear in the CRM's submissions panel as `APPLIED` **without** the `parsed`
  badge. That badge is the tell: while it keeps appearing, the portal is still sending
  only the formatted line.

## Verify

1. Deploy the portal.
2. On a staging order, complete Delivery & Site Details and **confirm** the address on
   file (do not retype it).
3. On the board, the new row should have Address Line 1, City, State, ZIP and Country
   populated alongside the formatted line.
4. In the CRM, Administration → Integrations → the submissions panel: `APPLIED`, with
   no `parsed` badge.

# Vercel setup — document renderer & vendor email

What has to be true on Vercel for the Bill of Materials and the Ryan Capital
financing sheet to render as PDFs and be emailed to a vendor.

Everything below fits inside the **Pro** plan you already pay for. There is no
new subscription; the only added cost is function execution time on documents you
actually render.

---

## 1. Install the two renderer packages

```bash
pnpm add playwright-core @sparticuz/chromium-min
```

Why these two and not `playwright`:

- **`playwright-core`** is the driver with no bundled browser (~2 MB). The full
  `playwright` package ships a ~300 MB browser and would blow Vercel's 250 MB
  unzipped function limit on its own.
- **`@sparticuz/chromium-min`** is a Chromium build stripped for Lambda-style
  hosts. The `-min` variant contains no browser either — it downloads a
  compressed pack at cold start and unpacks it to `/tmp`. That is what keeps the
  deployed function under the size cap.

Both are imported lazily, so if this step is skipped the app still boots and
Excel export still works — PDF export just reports that it is not installed.

## 2. Host the Chromium pack and set `CHROMIUM_PACK_URL`

`chromium-min` needs a URL to fetch the browser from. Use the `.tar` from the
`@sparticuz/chromium` GitHub release whose Chromium version matches the
`playwright-core` you installed (the release notes state it).

Two options:

- **Point at the GitHub release asset directly.** Simplest, and fine to start.
- **Copy the `.tar` into Vercel Blob storage and point at that.** Preferred once
  this is load-bearing: a cold start then never depends on GitHub being up, and
  the download is same-region so it is faster.

Either way the value goes in `CHROMIUM_PACK_URL`. Leave it **unset locally** —
with no pack URL the renderer uses the Playwright browser already on your
machine.

> Version drift between the pack and `playwright-core` is the one failure mode
> here, and it fails loudly at launch rather than producing a bad PDF. Pin both.

## 3. Function sizing is already in `vercel.json`

The repo now has a second serverless entry, `api/render.ts`, and everything under
`/render/*` is routed to it:

```json
"functions": {
  "api/index.ts":  { "maxDuration": 30 },
  "api/render.ts": { "memory": 2048, "maxDuration": 60 }
}
```

Both entries build the same Fastify app — the split exists only so they can be
sized differently. **This is the part worth understanding:** Vercel bills memory
× duration. If the single existing function were raised to 2 GB, every page view,
every catalog search and every proposal save would be billed at 2 GB for a
browser it never launches. Keeping the renderer separate means only an export
pays for it.

2048 MB is the working figure: Chromium needs roughly 1.5 GB, and Vercel scales
CPU with memory, so a smaller function is not just tighter — it is slower.

Nothing to do here beyond deploying; it is committed.

## 4. Environment variables

Add these in **Project → Settings → Environment Variables** (Production and
Preview). Everything except `CHROMIUM_PACK_URL` has a working default, so add
only what you want to change.

| Variable | Purpose |
|---|---|
| `CHROMIUM_PACK_URL` | Browser pack from step 2. Without it, PDF export fails on Vercel and works locally. |
| `RESEND_API_KEY` | Already set for invites and password resets. The same key sends vendor BOMs. |
| `BOM_FROM_EMAIL` | Default `orders@updates.summitsensory.com`. **Must** be on the Resend-verified subdomain. |
| `BOM_FROM_NAME` | Default `Summit Sensory Gym`. |
| `BOM_REPLY_TO` | Default `Orders@SummitSensory.com` — where a vendor's reply lands. Does *not* need to be a verified domain. |
| `BOM_BCC_EMAIL` | Optional. Blind-copies every vendor BOM to one internal inbox. |
| `FINANCE_PARTNER_EMAIL` | Default `ckinsey@ryancapital.com`. |

### The from-address rule that bites people

Resend will only send from a domain verified in your Resend account. Yours is the
**subdomain** `updates.summitsensory.com`, not `summitsensory.com`. A vendor sees
"Summit Sensory Gym" as the sender name and their reply goes to
`Orders@SummitSensory.com`, so the subdomain is invisible to them — but setting
`BOM_FROM_EMAIL` to a bare `@summitsensory.com` address will be **rejected at
send time**, and the failure is recorded against that send in the audit trail.

### Deliverability, before you send a vendor anything

Vendor email is different from an internal invite: it goes to people who have
never received mail from this domain, and an attachment raises the bar further.
Check in Resend that `updates.summitsensory.com` has **SPF, DKIM and DMARC** all
green. Attachments from a domain without DKIM land in junk, and you will not be
told — the send will simply report success.

## 5. Run the migration

`0029_bom_vendor_sections` creates the per-vendor sections, the question tables,
the send audit trail, the colour brands and the financing factors — and backfills
one section per existing (order, vendor).

```bash
pnpm db:migrate:deploy
```

It is additive: no column is dropped and the order-level BOM header stays exactly
where it is, so a rollback is a redeploy of the previous build.

## 6. Verify, in this order

1. **Deploy** and confirm the app loads as normal — the renderer is lazy, so a
   missing pack cannot break the site.
2. **Open any order** and confirm each vendor now has its own section with today's
   date shown as its submission date.
3. **Export one section as PDF.** First call is slow (cold start, 3-5 s); the next
   is under a second while the container stays warm.
4. **Send a BOM to yourself** before sending one to a vendor. Check the audit row
   records the address, the timestamp and the sender.
5. **Check Vercel's function log** for `api/render` — if the pack URL is wrong, the
   launch error names the version mismatch.

---

## What the audit trail records

Every send writes a row against that vendor's section, and it is append-only —
nothing in the UI edits or deletes one:

| Recorded | From |
|---|---|
| **Who sent it** | the signed-in user, resolved to their name |
| **When** | timestamp of the send |
| **Who it went to** | the To and Cc addresses actually used, not the vendor's saved default |
| **What was sent** | subject line and attachment format (Excel, PDF or both) |
| **What happened** | accepted / failed, with the provider's error text when it failed |

So "who on our team sent this, to which address at the vendor, and when" is fully
answered, including when the same BOM is re-sent after an unlock — each send is
its own row, so the history reads as a sequence.

---

## What this does not cover

- **Proof the recipient read it.** Delivery status (delivered / bounced) is honest
  and comes from the provider. An open receipt is not: most corporate mail clients
  block the tracking pixel, so "not opened" would mean nothing. The trail stops at
  delivered.
- **The delivery webhook itself.** Wiring Resend's webhook to move a row from
  `SENT` to `DELIVERED` or `BOUNCED` is a follow-up; until then rows stay at
  `SENT` and the send-time success or failure is still recorded.

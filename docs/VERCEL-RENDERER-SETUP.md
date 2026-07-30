# Vercel setup — click by click

Everything you do inside the Vercel dashboard, in order. Assumes the build 41
files are already committed and pushed.

Your plan (Pro) covers all of this. No new subscription.

---

## Before you start

Open two tabs:

- **Vercel** → your project
- **GitHub** → `github.com/Sparticuz/chromium/releases`

---

## 1. Install the packages — pinned, exact versions

The current Sparticuz release is **149.0.0** (Chromium 149). Pin to it rather than
using `latest`, so a future release cannot change your browser under you:

```bash
pnpm add playwright-core @sparticuz/chromium-min@149.0.0
```

Then check what you got:

```bash
pnpm list playwright-core @sparticuz/chromium-min
```

Commit `package.json` and `pnpm-lock.yaml`.

### Why the versions don't have to match exactly

Since Playwright 1.57 the bundled browser is *Chrome for Testing*, not Chromium —
so strictly speaking Playwright's browser and the Sparticuz pack are different
builds. That does not matter here, because the renderer passes an explicit
`executablePath` and drives whatever binary it is pointed at over the DevTools
protocol. Any recent `playwright-core` speaks to Chromium 149 without complaint.

What you must not do is drift far apart — a pack several majors behind your
`playwright-core` will eventually hit a protocol method the old browser lacks.
When you bump one, bump the other, and re-run the verify step.

## 2. Get the pack URL

The `-min` package ships no browser; it downloads one on first use. For 149.0.0
the URL is:

```
https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar
```

Vercel functions are **x64** — take the `x64` pack, not `arm64`.

If you pinned a different version, the pattern is the same: on
`github.com/Sparticuz/chromium/releases`, open the release, and under **Assets**
copy the link to `chromium-v<version>-pack.x64.tar`.

Hold that URL — it goes into Vercel in step 4.

> A mismatch fails loudly at browser launch and the error names both versions. It
> will never produce a silently wrong PDF.

## 3. (Recommended) Host the pack yourself

Skippable to start, but do it before this is load-bearing: a cold start otherwise
depends on GitHub being reachable, and a cross-region download is slower.

1. Vercel → your project → **Storage** tab
2. **Create Database** → **Blob** → name it `assets` → **Create**
3. Open the store → **Upload** → select the `.tar` you downloaded
4. Copy the resulting public URL — use it instead of the GitHub link

Blob storage is included on Pro at your volume; a ~50 MB file costs nothing
meaningful.

## 4. Set the environment variables

Vercel → your project → **Settings** → **Environment Variables**.

For each row: type the name, paste the value, tick **Production** and
**Preview**, click **Save**.

**Required:**

| Name | Value |
|---|---|
| `CHROMIUM_PACK_URL` | the `.tar` URL from step 2 (or your Blob copy from step 3) |

**Optional** — every one has a working default, so only add what you want to
change:

| Name | Default if you skip it |
|---|---|
| `BOM_FROM_EMAIL` | `orders@updates.summitsensory.com` |
| `BOM_FROM_NAME` | `Summit Sensory Gym` |
| `BOM_REPLY_TO` | `Orders@SummitSensory.com` |
| `BOM_BCC_EMAIL` | *(none — set it to blind-copy every vendor BOM internally)* |
| `FINANCE_PARTNER_EMAIL` | `ckinsey@ryancapital.com` |
| `RESEND_WEBHOOK_SECRET` | *(unset — see below)* |

### Delivery confirmation (optional, recommended)

Without this the audit trail stops at "sent". With it, a row moves to
**Delivered** or **Bounced** on its own.

1. Resend → **Webhooks** → **Add Endpoint**
2. URL: `https://<your-domain>/webhooks/resend`
3. Subscribe to `email.delivered` and `email.bounced` only
4. Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET`

The endpoint refuses every request until that secret is set — an unauthenticated
endpoint that writes to an audit trail is worse than no endpoint. Signatures are
verified and anything older than five minutes is rejected, so a captured payload
cannot be replayed.

`email.opened` is deliberately **not** subscribed. Most corporate mail clients
block the tracking pixel, so "not opened" would mean nothing — putting it on screen
would look like evidence and would not be. A bounce also lands on the order
timeline, because nobody would otherwise find out the vendor never got the sheet.

`RESEND_API_KEY` is already set from the invite and password-reset work. The same
key sends vendor BOMs — nothing to add.

> **The one rule:** if you override `BOM_FROM_EMAIL`, keep it on
> `updates.summitsensory.com`. That subdomain is what is verified in Resend; a
> bare `@summitsensory.com` sender is rejected at send time. The vendor never sees
> it — the sender name reads "Summit Sensory Gym" and replies go to `BOM_REPLY_TO`.

## 5. Confirm the function sizing landed

Vercel reads this from the committed `vercel.json`, so there is nothing to click —
just verify after the next deploy.

**Deployments** → newest → **Functions** tab. You should see two:

| Function | Memory | Max duration |
|---|---|---|
| `api/index` | default | 30 s |
| `api/render` | 2 GB | 60 s |

If `api/render` is missing, `vercel.json` did not get committed.

**Why two:** Vercel bills memory × duration. Chromium needs ~1.5 GB, but if the
single existing function were raised to 2 GB then every page view and every
catalog search would be billed at 2 GB for a browser it never launches. The split
means only an export pays.

## 6. Run the database migration

**Vercel does not run migrations.** Your build command is
`prisma generate && pnpm build` — it generates the client, it does not touch the
database. This is the right default: an auto-migrating build can wedge a
deployment halfway through a schema change.

Run it yourself, from your machine, against production:

1. Take a database snapshot in your provider's dashboard. One click.
2. Vercel → **Settings** → **Environment Variables** → reveal `DIRECT_URL` and
   copy it. (`DATABASE_URL` is the pooled connection — migrations need the direct
   one.)
3. Locally:

```bash
DIRECT_URL="<paste>" DATABASE_URL="<paste>" pnpm db:migrate:deploy
DIRECT_URL="<paste>" DATABASE_URL="<paste>" pnpm db:migrate:status
```

`status` should report no pending migrations.

Migration 0029 is additive — nothing is dropped — and it backfills one BOM section
per existing (order, vendor), so current orders render unchanged.

## 7. Deploy

Merge the branch. Vercel builds on push.

Watch **Deployments** → the running build. If it fails, the log names the file.
The likely cause is a missing `pnpm db:generate` before commit, which leaves the
Prisma client out of step with the new schema.

## 8. Verify on the deployed site

In this order — each step rules out the previous one as a cause:

1. **The app loads normally.** The renderer is imported lazily, so a wrong pack URL
   cannot break the site.
2. **Open any order.** Each vendor has its own BOM section, showing today's date as
   its submission date.
3. **Export one section as PDF.** First call takes 3–5 s (cold start), the next is
   under a second while the container stays warm.
4. **Send a BOM to yourself.** Confirm the audit row records your name, the
   address and the timestamp.

If step 3 fails: Vercel → **Logs**, filter to the `api/render` function. A pack
mismatch names both versions; a missing `CHROMIUM_PACK_URL` says PDF is not
installed.

## 9. Before the first real vendor send

In **Resend** → **Domains** → `updates.summitsensory.com`, confirm **SPF, DKIM and
DMARC** are all green.

A first-contact email carrying an attachment, from a domain without DKIM, goes to
junk — and the send still reports success, so nothing tells you it happened.

---

## Cost, concretely

- **Blob storage** for the pack: a rounding error at one 50 MB file.
- **`api/render`**: billed only while rendering. At 2 GB for ~3 s, roughly a
  hundred documents sits inside your included Pro usage.
- **`api/index`**: unchanged.

No plan upgrade.

## If you need to roll back

Vercel → **Deployments** → the previous good one → **⋯** → **Promote to
Production**.

Migration 0029 drops nothing, so the old code runs against the new schema without
error — the new tables simply sit unused. There is no database rollback to do.

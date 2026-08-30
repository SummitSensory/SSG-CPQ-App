# Deployment Runbook — crm.summitsensory.com

Click-by-click. Do the parts in order; each one depends on the last.

**What you're building**

| Environment | Git branch | Address                         | Purpose                    |
| ----------- | ---------- | ------------------------------- | -------------------------- |
| Staging     | `staging`  | `crm-staging.summitsensory.com` | Test everything here first |
| Production  | `main`     | `crm.summitsensory.com`         | The real thing             |

**Time:** about 45 minutes of clicking, plus up to an hour of waiting for DNS.

**Before you start, have open:** your Vercel account, your Bluehost account,
and a scratch text file to paste secrets into as you generate them.

---

# Part A — Generate your secrets first

You'll need six random values. Generate them now so you're not stopping midway.

**Windows** — open PowerShell (Start → type "PowerShell"). Run the first
command four times, the second twice:

```powershell
# base64 — the four JWT secrets
[Convert]::ToBase64String((1..48 | ForEach-Object {Get-Random -Max 256}))

# hex — the two QuickBooks encryption keys
-join ((1..32) | ForEach-Object {'{0:x2}' -f (Get-Random -Max 256)})
```

Node works too, in plain `cmd`:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Mac / Linux / Git Bash** — run the first four times, the second twice:

```bash
openssl rand -base64 48
openssl rand -hex 32
```

Label the six results in your scratch file:

```
PROD  JWT_ACCESS_SECRET   = <base64 #1>
PROD  JWT_REFRESH_SECRET  = <base64 #2>
STAGE JWT_ACCESS_SECRET   = <base64 #3>
STAGE JWT_REFRESH_SECRET  = <base64 #4>
PROD  QBO_TOKEN_ENC_KEY   = <hex #1>
STAGE QBO_TOKEN_ENC_KEY   = <hex #2>
```

Never reuse a value between staging and production. Never put these in the
repo — Vercel is the only place they go.

---

# Part B — Create the staging branch

In Terminal, from the project folder:

```bash
git checkout main
git pull
git checkout -b staging
git push -u origin staging
```

You now have two branches on GitHub: `main` and `staging`.

---

# Part C — Create the Vercel project

1. Go to **vercel.com** and sign in.
2. Top right, click **Add New… → Project**.
3. Under "Import Git Repository", find the CPQ repo. If you don't see it, click
   **Adjust GitHub App Permissions** and grant Vercel access to that repo.
4. Click **Import**.
5. On the configure screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** leave as `./`
   - **Build and Output Settings:** leave everything alone. Do not override the
     build command — `vercel.json` in the repo already sets it.
6. Skip the Environment Variables box for now (Part E covers it properly).
7. Click **Deploy**.

**This first deploy will fail.** That's expected — there's no database yet.
Click through to the project dashboard and continue.

---

# Part D — Create the database

1. In your project, click the **Storage** tab.
2. Click **Create Database**.
3. Choose **Neon** (Serverless Postgres). Click **Continue**.
4. Plan: **Free** is fine to start.
5. Region: pick the one closest to you (e.g. `US East (N. Virginia)`).
6. Database name: `summit-cpq-prod`. Click **Create**.
7. On the "Connect to Project" screen, check **Production** only. Uncheck
   Preview and Development. Click **Connect**.

Now the staging database:

8. Back on **Storage**, click **Create Database → Neon** again.
9. Name it `summit-cpq-staging`, same region, click **Create**.
10. Connect it to **Preview** only (uncheck Production and Development).

Vercel now injects the correct `DATABASE_URL` automatically depending on which
environment is running. You don't set that variable by hand.

**Save both connection strings.** Click each database → **`.env.local`** tab →
copy the `DATABASE_URL` line into your scratch file, labelled PROD and STAGE.
You need them in Part G.

---

# Part E — Environment variables

Go to **Settings → Environment Variables**.

For each row below: type the **Key**, paste the **Value**, then use the
environment checkboxes to tick **only** the environment named. Click **Save**
after each one. Yes, it's tedious — there are 26.

### Production rows (tick "Production" only)

| Key                            | Value                                                            |
| ------------------------------ | ---------------------------------------------------------------- |
| `NODE_ENV`                     | `production`                                                     |
| `LOG_LEVEL`                    | `info`                                                           |
| `JWT_ACCESS_SECRET`            | your PROD access secret                                          |
| `JWT_REFRESH_SECRET`           | your PROD refresh secret                                         |
| `JWT_ACCESS_TTL`               | `900`                                                            |
| `JWT_REFRESH_TTL`              | `1209600`                                                        |
| `SEED_ADMIN_EMAIL`             | your email address                                               |
| `QBO_TOKEN_ENC_KEY`            | your PROD hex key                                                |
| `QBO_ENVIRONMENT`              | `sandbox`                                                        |
| `QBO_PRODUCTION_WRITE_ENABLED` | `false`                                                          |
| `QBO_REDIRECT_URI`             | `https://crm.summitsensory.com/integrations/quickbooks/callback` |
| `MONDAY_API_TOKEN`             | leave blank                                                      |
| `MONDAY_SIGNING_SECRET`        | leave blank                                                      |

### Staging rows (tick "Preview" only)

| Key                            | Value                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| `NODE_ENV`                     | `production`                                                             |
| `LOG_LEVEL`                    | `debug`                                                                  |
| `JWT_ACCESS_SECRET`            | your STAGE access secret                                                 |
| `JWT_REFRESH_SECRET`           | your STAGE refresh secret                                                |
| `JWT_ACCESS_TTL`               | `900`                                                                    |
| `JWT_REFRESH_TTL`              | `1209600`                                                                |
| `SEED_ADMIN_EMAIL`             | your email address                                                       |
| `QBO_TOKEN_ENC_KEY`            | your STAGE hex key                                                       |
| `QBO_ENVIRONMENT`              | `sandbox`                                                                |
| `QBO_PRODUCTION_WRITE_ENABLED` | `false`                                                                  |
| `QBO_REDIRECT_URI`             | `https://crm-staging.summitsensory.com/integrations/quickbooks/callback` |
| `MONDAY_API_TOKEN`             | leave blank                                                              |
| `MONDAY_SIGNING_SECRET`        | leave blank                                                              |

`NODE_ENV` is `production` on staging too — that's correct. It means "run the
optimized build," not "this is the live site."

Leave the monday and QuickBooks credentials blank. The app detects the blanks
and disables those integrations cleanly.

---

# Part F — Add the domains in Vercel

Go to **Settings → Domains**.

**Production domain**

1. Type `crm.summitsensory.com` in the box. Click **Add**.
2. Choose **Add** on the plain option (not the redirect option).
3. Vercel shows a **Invalid Configuration** warning and a box with the record
   you need. It will say something like:
   > Type: `CNAME` Name: `crm` Value: `cname.vercel-dns.com`
4. **Copy that Value exactly.** Write it in your scratch file. Use _that_ value
   in Part G — not the one printed in this document, in case Vercel changed it.

**Staging domain**

5. Type `crm-staging.summitsensory.com`. Click **Add**.
6. This one must point at the staging branch: find `crm-staging` in the domain
   list, click the **⋯** menu → **Edit**, and set **Git Branch** to `staging`.
   Save.
7. Copy its CNAME value too (it's normally the same one).

Both will sit in a warning state until DNS is done. That's fine.

---

# Part G — DNS at Bluehost

Bluehost has two different interfaces depending on your account age. Try the
first; if the menus don't match, use the second.

### The newer Bluehost interface

1. Sign in at **bluehost.com**.
2. Left sidebar → **Domains**.
3. Find `summitsensory.com` in the list → click **Manage** (or the domain name).
4. Click the **DNS** tab.
5. Scroll to the **CNAME (Alias)** section → click **Add Record**.
6. Fill in:
   - **Host Record / Name:** `crm`
   - **Points To / Value:** the value you copied from Vercel
   - **TTL:** leave the default (14400 / 4 hours)
7. Click **Save**.
8. Click **Add Record** again and repeat with **Host Record:** `crm-staging`.

### The older cPanel interface

1. Sign in → **Advanced** (left sidebar) → opens cPanel.
2. Under **Domains**, click **Zone Editor**.
3. Find `summitsensory.com` → click **Manage**.
4. Click **+ Add Record** → choose **Add CNAME Record**.
5. Fill in:
   - **Name:** `crm`
   - **CNAME:** the value you copied from Vercel
   - **TTL:** `14400`
6. Click **Add Record**, then repeat for `crm-staging`.

### Five things that go wrong on Bluehost

1. **Enter just `crm`, not `crm.summitsensory.com`.** Bluehost appends the
   domain for you. After saving, the record will _display_ as
   `crm.summitsensory.com.` with a trailing dot — that's correct.
2. **Do not use the "Subdomains" tool** (Domains → Subdomains). It creates a
   folder on your hosting plan and an A record that conflicts with the CNAME.
   Only use the DNS / Zone Editor page.
3. **If a record for `crm` already exists**, edit it instead of adding a
   second. Two records for the same name will break it. Delete any A record
   for `crm` if one appears.
4. **Don't touch `@`, `www`, or the MX records.** Your marketing site and email
   keep working untouched.
5. **Don't add a CNAME with a value ending in a period** unless Bluehost's own
   field already shows one.

---

# Part H — Wait, then confirm

DNS usually takes 15–60 minutes at Bluehost, occasionally up to 4 hours.

Check progress:

```bash
dig crm-staging.summitsensory.com CNAME +short
```

When it prints the Vercel value, you're through. (No Terminal? Use
**dnschecker.org**, type the subdomain, choose CNAME.)

Then go back to Vercel **Settings → Domains**. Both entries should turn to a
green checkmark on their own — Vercel issues the SSL certificate automatically.
If either still shows a warning after DNS resolves, click **Refresh** on that
domain.

---

# Part I — Set up the staging database

Only after `crm-staging.summitsensory.com` resolves.

In Terminal, from the project folder:

```bash
# Point at STAGING — paste the staging connection string from Part D
export DATABASE_URL="postgresql://…your staging string…"

pnpm install
pnpm db:migrate:deploy     # creates all the tables
pnpm db:seed               # creates your admin login
pnpm db:seed:catalog       # loads 341 products + tier tree + costs + sourcing
```

`pnpm db:seed` prints a generated password **once**:

```
  Generated password (shown once — copy it now):

      xK3mP9qR2vL8nW4tY6bZ1cF5

  Sign in, then change it from the sidebar.
```

Copy it immediately into your scratch file.

Want to check the catalog data before writing it? Run
`pnpm db:seed:catalog --dry-run` first — it validates and reports, no writes.

---

# Part J — Test staging

1. Open `https://crm-staging.summitsensory.com/health` — should return OK.
2. Open `https://crm-staging.summitsensory.com` and sign in with your email and
   the generated password.
3. Change the password from the sidebar.
4. Go to the Catalog. Confirm the tier tree shows:
   Adventure Series Frame · Dual Trolley System · Therapeutic Activity &
   Adventure Components · Adventure Mat System · Summit Foundation System ·
   Hardware.
5. Build a test proposal start to finish.
6. Confirm `https://crm.summitsensory.com` is still empty — production has no
   database tables yet.

---

# Part K — Go live

Only when staging has passed everything in Part J.

```bash
# Point at PRODUCTION — the prod connection string from Part D
export DATABASE_URL="postgresql://…your production string…"

pnpm db:migrate:deploy
pnpm db:seed
pnpm db:seed:catalog
```

Then merge staging into main:

```bash
git checkout main
git merge staging
git push
```

Vercel deploys `main` to `crm.summitsensory.com` automatically. Sign in there
and change the admin password.

---

# From then on

```
make changes → push to `staging` → test at crm-staging → merge to `main` → live
```

Every pull request also gets its own throwaway preview URL, so you can look at
a change before it even reaches staging.

---

# If something breaks

**Deploy fails.** Vercel → **Deployments** → click the failed one → **Building**
log. The error is at the bottom in red.

**Site loads but errors on every page.** Almost always a missing environment
variable. Check Part E — especially that `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` are set on the right environment.

**"Invalid Configuration" won't clear.** The CNAME value is wrong, or there's a
leftover A record for `crm` in Bluehost. Run
`dig crm.summitsensory.com CNAME +short` and compare against what Vercel shows.

**Migrations fail.** Your `DATABASE_URL` is pointed at the wrong database, or
still has the previous `export` in effect. Run `echo $DATABASE_URL` to check
before running anything destructive.

**Anything else** — send me the error text and I'll work it out.

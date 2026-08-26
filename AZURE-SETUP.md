# Outlook drafts — Azure setup

Follow-up emails currently download as an `.eml` file you then have to open. With this
set up, the CRM writes the email straight into your Outlook mailbox as a draft and opens
it. No download, and the draft is in Drafts on every device.

You already have an Azure app registration for Microsoft sign-in. **These steps add
permission to that same app** rather than creating a second one — one app, one secret to
rotate, one consent screen. Everything below happens in the Azure portal at
[portal.azure.com](https://portal.azure.com), signed in as a user who can administer
Microsoft Entra ID (Global Administrator, Application Administrator, or Cloud Application
Administrator).

Total time: about fifteen minutes.

---

## Step 1 — Open the existing app registration

1. Go to **portal.azure.com**.
2. In the search bar at the top, type **Microsoft Entra ID** and open it.
3. In the left menu, select **App registrations**.
4. Select the **All applications** tab (the default tab hides apps you did not personally
   create).
5. Find the app used for CRM sign-in and open it. If you are unsure which it is, match the
   **Application (client) ID** column against the `ENTRA_CLIENT_ID` value in Vercel →
   your project → Settings → Environment Variables.

On the **Overview** page, copy these two values into a scratch note — you need them in
step 5:

- **Directory (tenant) ID**
- **Application (client) ID**

They should match the `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` already in Vercel. If they
do, you do not need to change either variable.

---

## Step 2 — Add the redirect URI

Microsoft will only return the browser to a URL you have registered here, character for
character.

1. In the left menu of the app registration, select **Authentication**.
2. Under **Platform configurations** you should already see a **Web** platform with the
   sign-in redirect URI in it. Select **Add URI** under that Web platform.
   - If there is no Web platform, select **Add a platform** → **Web** first.
3. Enter exactly:

   ```
   https://crm.summitsensory.com/me/outlook/callback
   ```

4. If you also want this to work on Vercel preview deployments or locally, select **Add
   URI** again for each:

   ```
   https://localhost:3000/me/outlook/callback
   ```

   Preview URLs change per deployment, so it is usually not worth registering them —
   test on production or locally.

5. Leave **Front-channel logout URL** and the **Implicit grant** checkboxes exactly as
   they are. Do not tick "Access tokens" or "ID tokens" — this flow does not use implicit
   grant, and enabling it weakens the app.
6. Select **Save** at the top.

---

## Step 3 — Add the Mail.ReadWrite permission

1. In the left menu, select **API permissions**.
2. Select **Add a permission**.
3. Choose **Microsoft Graph**.
4. Choose **Delegated permissions** — not Application permissions. This matters. A
   delegated permission lets the app act as the signed-in person, in their own mailbox
   only. The application-level equivalent would grant the app access to every mailbox in
   the tenant, which is far more than this needs.
5. In the search box type `Mail.ReadWrite`.
6. Tick **Mail.ReadWrite** ("Read and write access to user mail").
7. Search for `offline_access` and tick it too, if it is not already listed. This is what
   lets the connection survive longer than an hour — without it, every rep would have to
   reconnect several times a day.
8. Select **Add permissions**.

You should now see, in the **Configured permissions** list:

| API / Permission                                    | Type      | Admin consent required |
| --------------------------------------------------- | --------- | ---------------------- |
| Microsoft Graph → Mail.ReadWrite                    | Delegated | No                     |
| Microsoft Graph → offline_access                    | Delegated | No                     |
| Microsoft Graph → openid, profile, email, User.Read | Delegated | No                     |

### Grant admin consent (recommended)

`Mail.ReadWrite` does not strictly require admin consent, but granting it means each rep
sees no consent prompt at all — they click Connect and come straight back.

1. Select **Grant admin consent for Summit Sensory Gym** at the top of the permissions
   list.
2. Confirm **Yes**.
3. The **Status** column should turn to a green tick reading "Granted for Summit Sensory
   Gym".

If your tenant's policy is that users consent for themselves, skip this — the first
connect shows each rep a one-time Microsoft consent screen listing "Read and write access
to your mail", which they accept.

---

## Step 4 — Confirm the client secret

The app already has a secret, since sign-in works. You only need a new one if the existing
one is close to expiring.

1. In the left menu, select **Certificates & secrets** → **Client secrets** tab.
2. Look at the **Expires** column of the secret in use.
   - If it has more than a couple of months left, do nothing. Skip to step 5.
   - If it is expired or expiring, select **New client secret**, give it a description
     such as `CRM — Graph + SSO`, choose **24 months**, and select **Add**.
3. Copy the **Value** immediately — the portal shows it once and never again. It is the
   long string in the Value column, not the Secret ID.
4. Update `ENTRA_CLIENT_SECRET` in Vercel with the new value (step 5 covers where).

---

## Step 5 — Add the settings in Vercel

Go to [vercel.com](https://vercel.com) → your **SSG-CPQ-App** project → **Settings** →
**Environment Variables**.

Add these two. Everything else Graph needs is already there.

### `GRAPH_REDIRECT_URI`

```
https://crm.summitsensory.com/me/outlook/callback
```

This must be byte-identical to what you entered in step 2. No trailing slash, `https` not
`http`. Set it for **Production**. If you want it working on Preview too, add a second
entry scoped to Preview with that environment's URL.

### `GRAPH_TOKEN_ENC_KEY`

A 32-byte random key that encrypts the stored mailbox tokens. Generate one — do not invent
a passphrase by hand, and do not reuse `QBO_TOKEN_ENC_KEY`.

In PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Or in a terminal with Node available:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the result as the value. Set it for **Production** (and Preview, if you added a
preview redirect URI — the same value is fine).

> Treat this like a password. If you ever change it, every rep's stored connection becomes
> unreadable and everyone has to press Connect again. Nothing else breaks.

### Optional: a separate app registration

Only if you later want Graph on its own app rather than the sign-in app, add
`GRAPH_CLIENT_ID` and `GRAPH_CLIENT_SECRET`. Left unset, the sign-in app's credentials are
used. If you set one you must set both.

---

## Step 6 — Deploy the code and run the migration

From the repo:

```
npx prisma migrate deploy
npx prisma generate
npx tsc --noEmit
git add -A
git commit -m "Outlook drafts via Microsoft Graph"
git push
```

Migration `0055_outlook_drafts` adds the `OutlookConnection` table and a
`User.emailSignatureHtml` column. Nothing existing is altered, and the `.eml` route stays
in place.

Vercel redeploys on push. Wait for the deployment to go green before the next step —
`GRAPH_REDIRECT_URI` is read at boot, so a variable added after a deploy needs a redeploy
to take effect. If you added the variables after the last deploy, use **Deployments** →
the latest one → **⋯** → **Redeploy**.

---

## Step 7 — Connect your mailbox

1. Open the CRM and go to **Administration**.
2. Scroll to **Outlook drafts**.
3. Select **Connect Outlook**. You go to Microsoft, and back to a page saying
   "Outlook connected" with the mailbox named.
4. Paste your signature into the **Your signature** box and select **Save signature**.

That last part is not optional busywork, and it is worth knowing why. Outlook signatures
are stored by the Outlook app on your own machine — they are not in your mailbox and no
server can read them. A draft created through Graph therefore arrives with no signature,
and Outlook will not insert one into a message that already exists. Pasting it here is
what puts it on the email, and it goes at the bottom, every time.

Copy it out of Outlook the easy way: open a new email in Outlook, let the signature
appear, select it, copy, then paste into the box. The logo comes across with it.

Each rep does step 7 for themselves. Nobody can connect anyone else's mailbox — that is
what "delegated" means in step 3, and it is the reason this integration cannot read the
company's mail even if it wanted to.

---

## Checking it worked

Open a proposal → **Follow-up…** → pick a template → **Open in Outlook**.

- **Connected:** a tab opens with the draft, addressed, subject and body filled in,
  signature at the bottom. The same draft is in your Drafts folder in desktop Outlook
  within a few seconds.
- **Not connected:** the `.eml` downloads as before and the message says so, telling you
  to connect under Administration. This is the intended fallback, not a failure.

## If something goes wrong

**"AADSTS50011: The redirect URI specified in the request does not match"**
`GRAPH_REDIRECT_URI` in Vercel and the URI in step 2 are not identical. Usually a trailing
slash, `http` instead of `https`, or a preview URL against the production variable.

**"Outlook drafts are not configured on this deployment"**
The app booted without `GRAPH_REDIRECT_URI` or `GRAPH_TOKEN_ENC_KEY`. Add them and
redeploy. Administration → Outlook drafts names which one is missing.

**"Need admin approval"** on the Microsoft screen
Your tenant requires admin consent for `Mail.ReadWrite`. Go back to step 3 and use **Grant
admin consent**.

**"Microsoft did not return a refresh token"**
`offline_access` is missing from the app registration. Step 3, item 7.

**It worked, then stopped after a few weeks**
The refresh token or the client secret expired. The panel shows the reason and the fix is
**Reconnect** (rep) or a new client secret (admin, step 4).

**The draft opens in the browser, not in desktop Outlook**
That is what the link Microsoft returns does. The draft is genuinely in your mailbox, so
desktop Outlook has it in Drafts within seconds — open it there instead if you prefer. It
is the same message either way.

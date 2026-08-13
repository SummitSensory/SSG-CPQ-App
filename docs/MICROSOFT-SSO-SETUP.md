# Microsoft Entra ID single sign-on — setup

The code is already in the repository and needs no changes. SSO turns itself on when
four environment variables are present and turns itself off when any one of them is
missing (`isEntraConfigured()` in `src/config/env.ts`). This document is the
configuration work.

What is already built:

| Piece                                                                   | Where                                |
| ----------------------------------------------------------------------- | ------------------------------------ |
| OIDC authorization-code flow, confidential client                       | `src/auth/entra.ts`                  |
| `/auth/sso/status`, `/auth/sso/start`, `/auth/sso/callback`             | `src/routes/sso.ts`                  |
| Microsoft button on the login screen, shown only when SSO is configured | `public/app.js` (`/auth/sso/status`) |
| Env validation — all four keys required together                        | `src/config/env.ts`                  |

---

## 1. Register the application in Azure

Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.

- **Name**: `Summit Sensory Gym CPQ`
- **Supported account types**: _Accounts in this organizational directory only
  (Single tenant)_. The code pins the issuer to your tenant, so multi-tenant would
  fail token verification.
- **Redirect URI**: platform **Web**, value:

      https://crm.summitsensory.com/auth/sso/callback

Register, then copy from the **Overview** page:

- **Application (client) ID** → `ENTRA_CLIENT_ID`
- **Directory (tenant) ID** → `ENTRA_TENANT_ID`

## 2. Add the second redirect URI for preview

**Authentication** → **Add URI** under Web. Add the `qbo-sandbox` preview origin so
sign-in works there too:

      https://<your-preview-domain>.vercel.app/auth/sso/callback

Every environment needs its own entry, because `ENTRA_REDIRECT_URI` is sent on both
the authorize and the token request and Microsoft requires the two to match exactly.
No trailing slash, and `https` — Entra rejects `http` for anything but `localhost`.

Leave **Implicit grant** boxes unticked. The flow uses `response_mode=query` with an
authorization code; ID tokens are fetched server-side.

## 3. Create the client secret

**Certificates & secrets** → **Client secrets** → **New client secret**. 24 months is
the maximum. Copy the **Value** immediately — it is never shown again. That is
`ENTRA_CLIENT_SECRET`.

Diary the expiry date. When a secret lapses, sign-in fails with Microsoft's own
`AADSTS7000222` and the app surfaces it on the "Sign-in failed" page.

## 4. Confirm the token claims

**Token configuration** → **Add optional claim** → **ID** → tick `email`.

`completeLogin()` reads `email`, then falls back to `preferred_username`, then `upn`.
For a normal Microsoft 365 tenant `preferred_username` is already the address, so this
step is belt and braces — but a guest or a mail-less service account signs in without
it and gets "Your Microsoft account has no email address attached."

Permissions needed: `openid`, `profile`, `email` only. These are delegated,
consent-free defaults; **no admin consent and no Graph permission is required.**

## 5. Set the variables in Vercel

Project → **Settings** → **Environment Variables**. All four are required together;
setting three of four makes the app fail to boot with `required when Entra SSO is
configured`.

| Variable                | Production value                                  | Notes                                 |
| ----------------------- | ------------------------------------------------- | ------------------------------------- |
| `ENTRA_TENANT_ID`       | Directory (tenant) ID                             | GUID                                  |
| `ENTRA_CLIENT_ID`       | Application (client) ID                           | GUID                                  |
| `ENTRA_CLIENT_SECRET`   | the secret **Value**                              | not the Secret ID                     |
| `ENTRA_REDIRECT_URI`    | `https://crm.summitsensory.com/auth/sso/callback` | must match Azure exactly              |
| `ENTRA_ALLOWED_DOMAINS` | `summitsensory.com`                               | optional; this is already the default |
| `ENTRA_DEFAULT_ROLE`    | `READ_ONLY`                                       | optional; this is already the default |

Add the same set to the **Preview** environment with the preview redirect URI.

Redeploy. Env changes do not reach a running deployment.

## 6. Verify

1. `GET https://crm.summitsensory.com/auth/sso/status` returns `{"enabled":true}`.
   If it returns `false`, one of the four variables is missing or the deploy is stale.
2. Load the login page. The **Sign in with Microsoft** block is now visible.
3. Sign in with a `@summitsensory.com` account.
4. Confirm you land back in the workspace signed in.

---

## What happens on a first sign-in

A Microsoft account with no matching user row is **auto-provisioned** at
`ENTRA_DEFAULT_ROLE`, which defaults to `READ_ONLY`. The account is created with a
random password hash, so it is SSO-only until somebody sets a real password. An invite
email goes out through Resend if `RESEND_API_KEY` is set.

Two consequences worth knowing before you switch this on:

- **Anyone in the tenant with a `summitsensory.com` address can sign in** and will get
  a read-only account. They see nothing they can change, but they are in. Narrow it by
  tightening `ENTRA_ALLOWED_DOMAINS`, or — if you want an explicit allow-list — assign
  users in Azure under **Enterprise applications → Summit Sensory Gym CPQ →
  Properties → Assignment required = Yes**, then add only the people who should have
  access under **Users and groups**. Entra then refuses the token before the app sees
  it.
- **Roles are not read from Azure.** Entra decides _whether_ someone may sign in; the
  app's own `Role` decides what they may do. After a new person's first sign-in,
  promote them under Administration → Users. Adding them to an Azure group does
  nothing here.

An existing user whose `isActive` is false is refused with "That account has been
deactivated", so deactivating in Administration is enough to lock someone out of SSO
as well as password sign-in.

## Failure messages and where they come from

| What you see                                                | Cause                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No Microsoft button                                         | `/auth/sso/status` returned `enabled: false` — a variable is missing or the deploy predates it                     |
| `AADSTS50011` redirect URI mismatch                         | Azure's Web redirect URI and `ENTRA_REDIRECT_URI` differ (usually a trailing slash or `http`)                      |
| `AADSTS7000215` invalid client secret                       | Secret ID pasted instead of the secret Value, or the secret expired                                                |
| "Sign-in request expired. Please try again."                | The signed `state` JWT is older than 10 minutes, or `JWT_ACCESS_SECRET` changed between the start and the callback |
| "Sign-in could not be verified."                            | Nonce mismatch — a replayed or tampered callback                                                                   |
| "… is outside the organizations permitted to sign in here." | Email domain is not in `ENTRA_ALLOWED_DOMAINS`                                                                     |

`JWT_ACCESS_SECRET` signs the `state` parameter as well as app sessions. Rotating it
mid-login invalidates in-flight sign-ins; rotate it during a quiet window.

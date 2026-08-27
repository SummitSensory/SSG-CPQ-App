import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Pooled connection for the app (serverless-safe); direct for migrations.
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),

    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),

    // monday.com integration
    MONDAY_API_TOKEN: z.string().min(1).optional(),
    MONDAY_SIGNING_SECRET: z.string().min(1).optional(),
    MONDAY_DEALS_BOARD_ID: z.string().min(1).optional(),
    // The portal's Delivery & Site Details Submissions board. Same token, same
    // signed webhook, different board — the webhook routes on the board id. Left
    // unset it defaults to the live board (18421779422) in portalDelivery.ts, so
    // this only needs setting if that board is ever rebuilt.
    MONDAY_DELIVERY_BOARD_ID: z.string().min(1).optional(),
    // ---- Customer portal invite (Manufacturing Process board) ----
    // A staff member sets the trigger status to "Send Invite"; the portal's send is
    // driven off the invite status. The CRM closes the gap between the two, logs
    // every attempt, and repairs a missed one on the nightly sweep. All five are
    // optional: unset, the live board and column ids in portalInvite.ts are used.
    MONDAY_MANUFACTURING_BOARD_ID: z.string().min(1).optional(),
    // What a person sets (default color_mm547f1s) and what the portal watches
    // (default color_mm5427cr). They must not be the same column — that is a loop,
    // and isPortalInviteConfigured() refuses it rather than firing one.
    MONDAY_MFG_TRIGGER_COLUMN: z.string().min(1).optional(),
    MONDAY_MFG_INVITE_COLUMN: z.string().min(1).optional(),
    // The label that means "go", and the label written when it does. Both default
    // to "Send Invite". The written label must already exist on the invite column;
    // the integration reports it in words rather than inventing a second one.
    MONDAY_INVITE_TRIGGER_LABEL: z.string().min(1).optional(),
    MONDAY_INVITE_LABEL: z.string().min(1).optional(),

    // ---- Customer portal ----
    // Where the portal is served, used to build the customer's colour-selection
    // link. Unset means the link is returned to staff as a token to paste.
    PORTAL_BASE_URL: z.string().url().optional(), // Whether the CRM collects colour choices from the customer, replacing the
    // Jotform. `shadow` records the customer's picks and applies nothing, which is
    // how the path is proven on a real order beside the existing form. Only `live`
    // may write to a procurement line. Off is the default and the safe state.
    PORTAL_COLOR_SELECTION: z.enum(['off', 'shadow', 'live']).default('off'),

    // ---- Scheduled work ----
    // Bearer token Vercel Cron sends on its own scheduled requests. Unset means
    // /cron/* refuses outright rather than running unauthenticated — an open
    // endpoint that retries integration work is a way for anyone to hammer
    // monday's API.
    CRON_SECRET: z.string().min(16).optional(),

    // Where monday should post its webhooks. Set this explicitly in production:
    // a preview deployment's own URL is not where production's subscriptions
    // should point. VERCEL_URL is used as a fallback so previews can self-register.
    PUBLIC_BASE_URL: z.string().url().optional(),
    VERCEL_URL: z.string().min(1).optional(),

    // Microsoft Entra ID (Azure AD) single sign-on. Optional: when unset the
    // app runs with email + password only.
    ENTRA_TENANT_ID: z.string().min(1).optional(),
    ENTRA_CLIENT_ID: z.string().min(1).optional(),
    ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
    ENTRA_REDIRECT_URI: z.string().url().optional(),
    // Only these email domains may sign in via Entra. Comma-separated.
    // Without this, anyone who can authenticate against the tenant is
    // auto-provisioned an account.
    ENTRA_ALLOWED_DOMAINS: z.string().min(1).default('summitsensory.com'),
    // Role granted to a first-time SSO user when no group mapping applies. Least
    // privilege by default; an admin promotes from Settings → Users.
    ENTRA_DEFAULT_ROLE: z.string().min(1).default('READ_ONLY'),
    // Entra group → app role, as `key=ROLE` pairs separated by commas or newlines:
    //   8f2c…=SYSTEM_ADMIN, 41ab…=SALES_REP, d0e9…=ACCOUNTING
    // `key` is the group's object id (what a cloud-only tenant emits in the `groups`
    // claim); a group name works where the tenant emits names. Requires the groups
    // claim to be switched on in the app registration's Token configuration.
    // Unset means every SSO user lands on ENTRA_DEFAULT_ROLE, as before.
    ENTRA_ROLE_MAP: z.string().optional(),

    // ---- Outlook drafts (Microsoft Graph) ----
    // Where Microsoft returns the browser after a rep consents to let the CRM write
    // drafts into their mailbox, e.g. https://crm.summitsensory.com/me/outlook/callback.
    // Must match a Redirect URI on the app registration EXACTLY, character for character.
    GRAPH_REDIRECT_URI: z.string().url().optional(),
    // 32-byte key (hex or base64) that AES-256-GCM encrypts stored mailbox tokens. A
    // refresh token for a mailbox is a durable credential; it does not sit in the clear.
    GRAPH_TOKEN_ENC_KEY: z.string().min(32).optional(),
    // Only set these to run Graph off a SEPARATE app registration from SSO. Left unset,
    // the SSO app's credentials are reused — one app, one secret to rotate.
    GRAPH_CLIENT_ID: z.string().min(1).optional(),
    GRAPH_CLIENT_SECRET: z.string().min(1).optional(),

    // Domains whose users must sign in with Microsoft — the password form refuses
    // them. Comma-separated, e.g. `summitsensory.com`. Only enforced while Entra SSO
    // is actually configured, so a half-finished setup cannot lock everyone out.
    SSO_ENFORCED_DOMAINS: z.string().optional(),
    // Break-glass: these exact addresses keep password sign-in even inside an
    // enforced domain. One admin account here is the difference between an Entra
    // outage being an inconvenience and being a lockout.
    SSO_ENFORCE_EXEMPT_EMAILS: z.string().optional(),

    // Transactional email (Resend). Optional: without a key, invites are
    // logged instead of sent.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Must be an address on a domain verified in Resend. The verified domain is the
    // SUBdomain updates.summitsensory.com — sending as @summitsensory.com is rejected.
    INVITE_FROM_EMAIL: z.string().email().default('no-reply@updates.summitsensory.com'),
    INVITE_FROM_NAME: z.string().min(1).default('Summit Sensory CPQ'),
    // Where replies land. This one does NOT need to be a verified sending domain.
    INVITE_REPLY_TO: z.string().email().default('info@summitsensory.com'),
    // Password-reset email sender. Same verified-subdomain rule as above.
    RESET_FROM_EMAIL: z.string().email().default('info@updates.summitsensory.com'),
    RESET_FROM_NAME: z.string().min(1).default('Summit Sensory Gym'),
    RESET_REPLY_TO: z.string().email().default('info@summitsensory.com'),
    // Absolute base URL used to build reset links. When unset the request's own
    // host is used, which is correct on Vercel and in local dev alike.
    APP_BASE_URL: z.string().url().optional(),

    // Signing secret for Resend's delivery webhook (Resend → Webhooks → whsec_…).
    // Without it the webhook endpoint refuses every request: an unauthenticated
    // endpoint that writes to an audit trail is worse than no endpoint.
    RESEND_WEBHOOK_SECRET: z.string().optional(),

    // ---- Vendor + financing email (Bill of Materials, Ryan Capital sheet) ----
    // Same verified-subdomain rule as the senders above: the FROM address must be
    // on updates.summitsensory.com, while REPLY-TO can be the real inbox a vendor
    // should answer to.
    BOM_FROM_EMAIL: z.string().email().default('orders@updates.summitsensory.com'),
    BOM_FROM_NAME: z.string().min(1).default('Summit Sensory Gym'),
    BOM_REPLY_TO: z.string().email().default('Orders@SummitSensory.com'),
    // Every vendor BOM is silently copied here, so there is one internal record of
    // what left the building. Blank disables the copy.
    BOM_BCC_EMAIL: z.string().email().optional(),
    // Where unhandled server faults are emailed. Comma-separated for several.
    // Falls back to BOM_BCC_EMAIL; with neither set, faults are logged only — which
    // means the first report of an outage is somebody noticing.
    ALERT_EMAIL: z.string().min(3).optional(),
    // Where a financing request goes. Ryan Capital's contact of record.
    FINANCE_PARTNER_EMAIL: z.string().email().default('ckinsey@ryancapital.com'),

    // ---- Request for Freight ----
    // An RFQ goes out on the same sending identity as a BOM, but a freight quote
    // is a sales conversation, not a purchasing one: replies belong with the desk
    // that priced the job.
    RFQ_REPLY_TO: z.string().email().default('sales@summitsensory.com'),

    // ---- PDF renderer ----
    // Headless Chromium pack for serverless hosts, e.g. the @sparticuz/chromium
    // GitHub release .tar matching the installed playwright-core. Unset locally:
    // Playwright then uses the browser already installed on the machine.
    CHROMIUM_PACK_URL: z.string().url().optional(),

    // ---- Proposal e-signing (DocuSeal) ----
    // API token from DocuSeal → Settings → API. Unset means e-signing is switched
    // off: the routes report it plainly and every other path is unaffected.
    DOCUSEAL_API_TOKEN: z.string().min(1).optional(),
    // Cloud by default. Point this at a self-hosted instance's /api to move the
    // integration without touching code.
    DOCUSEAL_API_URL: z.string().url().default('https://api.docuseal.com'),
    // Host that serves the signer links, used to build a URL from a submitter slug.
    DOCUSEAL_SIGNING_BASE_URL: z.string().url().default('https://docuseal.com'),
    // Secret for the inbound webhook: set the same value as a custom
    // `X-Webhook-Secret` header on the DocuSeal webhook. Without it the endpoint
    // refuses every request.
    DOCUSEAL_WEBHOOK_SECRET: z.string().optional(),
    // Whether DocuSeal emails the signers. False when the signing link should go
    // out from the CRM instead — the envelope still records the per-signer URL.
    DOCUSEAL_SEND_EMAIL: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Optional DocuSeal folder for the per-send templates, so the account does not
    // become a flat list of every proposal ever sent.
    DOCUSEAL_FOLDER: z.string().min(1).optional(),
    // Vercel Blob read-write token: where the composed package and the executed PDF
    // are kept, so the signed contract does not live only inside DocuSeal. Unset is
    // supported — the envelope then keeps DocuSeal's own document URL.
    BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),

    // QuickBooks Online integration. Client credentials come from env ONLY —
    // never source. OAuth tokens are encrypted with QBO_TOKEN_ENC_KEY.
    QBO_CLIENT_ID: z.string().min(1).optional(),
    QBO_CLIENT_SECRET: z.string().min(1).optional(),
    QBO_REDIRECT_URI: z.string().url().optional(),
    // Which QuickBooks environment this deployment talks to.
    QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    // 32-byte key (hex or base64) used to AES-256-GCM encrypt stored tokens.
    QBO_TOKEN_ENC_KEY: z.string().min(32).optional(),
    // Hard safety gate: live financial writes to the PRODUCTION company are
    // refused unless this is explicitly 'true' AND the production test plan has
    // been authorized. Defaults off.
    QBO_PRODUCTION_WRITE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((v, ctx) => {
    // monday.com integration is optional; when unset the app runs without it.
    // If any QBO credential is present, the whole set (plus enc key) is required
    // — a half-configured financial integration must never start.
    const qboKeys = [
      'QBO_CLIENT_ID',
      'QBO_CLIENT_SECRET',
      'QBO_REDIRECT_URI',
      'QBO_TOKEN_ENC_KEY',
    ] as const;
    if (qboKeys.some((k) => v[k])) {
      for (const key of qboKeys) {
        if (!v[key])
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when QuickBooks is configured',
          });
      }
    }
    const entraKeys = [
      'ENTRA_TENANT_ID',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
      'ENTRA_REDIRECT_URI',
    ] as const;
    if (entraKeys.some((k) => v[k])) {
      for (const key of entraKeys) {
        if (!v[key])
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when Entra SSO is configured',
          });
      }
    }
    // Graph drafts ride on the Entra app registration, so half a Graph configuration
    // means a rep gets sent to Microsoft and cannot be brought back. Named plainly at
    // boot rather than discovered on the redirect.
    if (v.GRAPH_REDIRECT_URI || v.GRAPH_TOKEN_ENC_KEY || v.GRAPH_CLIENT_ID) {
      if (!v.GRAPH_REDIRECT_URI)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GRAPH_REDIRECT_URI'],
          message: 'required when Outlook drafts are configured',
        });
      if (!v.GRAPH_TOKEN_ENC_KEY)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GRAPH_TOKEN_ENC_KEY'],
          message: 'required when Outlook drafts are configured',
        });
      if (!v.ENTRA_TENANT_ID)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENTRA_TENANT_ID'],
          message: 'required when Outlook drafts are configured',
        });
      if (v.GRAPH_CLIENT_ID && !v.GRAPH_CLIENT_SECRET)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GRAPH_CLIENT_SECRET'],
          message: 'required when GRAPH_CLIENT_ID is set',
        });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Normalize the raw environment before validation.
 *
 * Two hosting realities this absorbs:
 *
 * 1) A variable added in the Vercel dashboard with no value (or cleared later)
 *    arrives as an empty string, not as absent. Every optional field here is
 *    `.min(1)`, so an empty MONDAY_SIGNING_SECRET failed validation, `loadEnv()`
 *    threw at module scope, and the ENTIRE function crashed with
 *    FUNCTION_INVOCATION_FAILED — a 500 on every route, including the public
 *    monday webhook, because one optional integration secret was blank.
 *    Blank now means "not configured", which is what the operator meant.
 *
 * 2) Secrets pasted into a dashboard field routinely carry a trailing newline or
 *    space. Untrimmed, a signing secret still passes `.min(1)` and then fails
 *    every signature check at runtime — a far more expensive bug to find than a
 *    boot error. Trim once, here.
 */
function normalizeSource(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '') continue;
    out[key] = trimmed;
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(normalizeSource(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** True only when every monday credential is present, inbound webhooks included. */
export function isMondayConfigured(e: Env = env): boolean {
  return Boolean(e.MONDAY_API_TOKEN && e.MONDAY_SIGNING_SECRET && e.MONDAY_DEALS_BOARD_ID);
}

/**
 * What an OUTBOUND write to monday actually needs: a token to authenticate with and
 * a board to write to. MONDAY_SIGNING_SECRET verifies the JWT on webhooks monday
 * sends US — it has no part in a push, and it only exists if someone registered a
 * monday app. Requiring it here meant a correctly credentialled deployment reported
 * "monday.com is not configured on this deployment" when a proposal was released.
 */
export function isMondayPushConfigured(e: Env = env): boolean {
  return Boolean(e.MONDAY_API_TOKEN && e.MONDAY_DEALS_BOARD_ID);
}

/** Inbound webhooks are the one path that genuinely needs the signing secret. */
export function isMondayWebhookConfigured(e: Env = env): boolean {
  return Boolean(e.MONDAY_API_TOKEN && e.MONDAY_SIGNING_SECRET);
}

/**
 * Whether the CRM may write a customer's colour picks onto an order.
 *
 * Three states rather than a boolean on purpose: `shadow` exists so the path can
 * be run beside the Jotform on a real job and compared, which is the condition for
 * turning the Jotform off at all.
 */
export function portalColorSelectionMode(e: Env = env): 'off' | 'shadow' | 'live' {
  return e.PORTAL_COLOR_SELECTION;
}

/** True only when every Entra SSO setting is present. */
export function isEntraConfigured(e: Env = env): boolean {
  return Boolean(
    e.ENTRA_TENANT_ID && e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET && e.ENTRA_REDIRECT_URI,
  );
}

/**
 * Domains whose users must use Microsoft rather than the password form.
 *
 * Deliberately returns nothing unless SSO is configured. Enforcing this against a
 * deployment with no working SSO would refuse the password form and offer no
 * alternative — a locked door with no key, caused by one variable set too early.
 */
export function ssoEnforcedDomains(e: Env = env): string[] {
  if (!isEntraConfigured(e) || !e.SSO_ENFORCED_DOMAINS) return [];
  return e.SSO_ENFORCED_DOMAINS.split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/** Addresses exempt from the above, verbatim and lower-cased. */
export function ssoExemptEmails(e: Env = env): string[] {
  if (!e.SSO_ENFORCE_EXEMPT_EMAILS) return [];
  return e.SSO_ENFORCE_EXEMPT_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether this address must go through Microsoft instead of the password form.
 * Case-insensitive on both sides; an exempt address always wins.
 */
export function isPasswordSignInBlocked(email: string, e: Env = env): boolean {
  const addr = String(email || '')
    .trim()
    .toLowerCase();
  if (!addr.includes('@')) return false;
  if (ssoExemptEmails(e).includes(addr)) return false;
  return ssoEnforcedDomains(e).includes(addr.split('@')[1]!);
}

/** Lower-cased list of email domains permitted to sign in via Entra. */
export function entraAllowedDomains(e: Env = env): string[] {
  return e.ENTRA_ALLOWED_DOMAINS.split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * All an outbound send needs is the API token — the webhook secret guards inbound
 * events and the Blob token only decides where our copy is kept, so neither may
 * gate sending. Same lesson as isMondayPushConfigured.
 */
export function isDocusealConfigured(e: Env = env): boolean {
  return Boolean(e.DOCUSEAL_API_TOKEN);
}

/** Inbound DocuSeal webhooks need the shared secret as well as the token. */
export function isDocusealWebhookConfigured(e: Env = env): boolean {
  return Boolean(e.DOCUSEAL_API_TOKEN && e.DOCUSEAL_WEBHOOK_SECRET);
}

/** True only when every QuickBooks credential + token encryption key is present. */
export function isQuickbooksConfigured(e: Env = env): boolean {
  return Boolean(
    e.QBO_CLIENT_ID && e.QBO_CLIENT_SECRET && e.QBO_REDIRECT_URI && e.QBO_TOKEN_ENC_KEY,
  );
}

/** The QuickBooks environment this deployment targets, as the DB enum value. */
export function qboEnvironment(e: Env = env): 'SANDBOX' | 'PRODUCTION' {
  return e.QBO_ENVIRONMENT === 'production' ? 'PRODUCTION' : 'SANDBOX';
}

/**
 * True only when a rep can actually be walked through connecting their mailbox.
 *
 * Graph reuses the SSO app registration's client credentials unless GRAPH_CLIENT_ID
 * overrides them, so the tenant and a client id/secret pair have to be present either
 * way, plus this integration's own redirect URI and token encryption key.
 */
export function isOutlookConfigured(e: Env = env): boolean {
  const id = e.GRAPH_CLIENT_ID ?? e.ENTRA_CLIENT_ID;
  const secret = e.GRAPH_CLIENT_SECRET ?? e.ENTRA_CLIENT_SECRET;
  return Boolean(
    e.ENTRA_TENANT_ID && id && secret && e.GRAPH_REDIRECT_URI && e.GRAPH_TOKEN_ENC_KEY,
  );
}

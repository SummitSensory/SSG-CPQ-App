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
    // Role granted to a first-time SSO user. Least privilege by default; an
    // admin promotes from Settings → Users.
    ENTRA_DEFAULT_ROLE: z.string().min(1).default('READ_ONLY'),

    // Transactional email (Resend). Optional: without a key, invites are
    // logged instead of sent.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Must be an address on a domain verified in Resend.
    INVITE_FROM_EMAIL: z.string().email().default('no-reply@summitsensory.com'),
    INVITE_FROM_NAME: z.string().min(1).default('Summit Sensory CPQ'),

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
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** True only when every monday credential is present. */
export function isMondayConfigured(e: Env = env): boolean {
  return Boolean(e.MONDAY_API_TOKEN && e.MONDAY_SIGNING_SECRET && e.MONDAY_DEALS_BOARD_ID);
}

/** True only when every Entra SSO setting is present. */
export function isEntraConfigured(e: Env = env): boolean {
  return Boolean(
    e.ENTRA_TENANT_ID && e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET && e.ENTRA_REDIRECT_URI,
  );
}

/** Lower-cased list of email domains permitted to sign in via Entra. */
export function entraAllowedDomains(e: Env = env): string[] {
  return e.ENTRA_ALLOWED_DOMAINS.split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
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

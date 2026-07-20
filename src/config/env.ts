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
  })
  .superRefine((v, ctx) => {
    // In production the monday integration must be fully configured — no silent no-op.
    if (v.NODE_ENV === 'production') {
      for (const key of ['MONDAY_API_TOKEN', 'MONDAY_SIGNING_SECRET', 'MONDAY_DEALS_BOARD_ID'] as const) {
        if (!v[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required in production' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** True only when every monday credential is present. */
export function isMondayConfigured(e: Env = env): boolean {
  return Boolean(e.MONDAY_API_TOKEN && e.MONDAY_SIGNING_SECRET && e.MONDAY_DEALS_BOARD_ID);
}

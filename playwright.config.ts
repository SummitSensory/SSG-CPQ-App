import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000' },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // CI has no .env file — its secrets arrive as real environment
        // variables, so use the variant that doesn't try to read one.
        command: process.env.CI ? 'pnpm dev:ci' : 'pnpm dev',
        url: 'http://localhost:3000/health',
        reuseExistingServer: true,
        timeout: 30_000,
      },
});

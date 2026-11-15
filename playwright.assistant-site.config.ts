import { defineConfig, devices } from '@playwright/test';
/**
 * MIU 20: the whole path on the real Astro site, with the local BFF, Postgres,
 * worker, catalog and Channel intake behind it (no model, no email).
 *   ASSISTANT_SALES_SOURCE_ROOT=$PWD CHAT_TEST_DATABASE_URL=… \
 *     pnpm exec playwright test -c playwright.assistant-site.config.ts
 */
export default defineConfig({
  testDir: './tests/assistant-site',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: 'output/assistant-site/tests',
  reporter: [['list'], ['json', { outputFile: 'output/assistant-site/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:62059',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'pnpm --filter @vibelingan-channel/ai-worker exec tsx ../../scripts/assistant-chat-local.ts',
      url: 'http://127.0.0.1:62382/api/ai/healthz',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm --filter @vibelingan-channel/site dev:assistant-site',
      url: 'http://127.0.0.1:62059/',
      timeout: 180000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});

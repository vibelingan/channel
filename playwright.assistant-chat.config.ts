import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/assistant-chat',
  workers: 1,
  retries: 0,
  timeout: 20000,
  expect: { timeout: 7000 },
  outputDir: 'output/assistant-chat/tests',
  reporter: [['list'], ['json', { outputFile: 'output/assistant-chat/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:62058',
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
      command: 'pnpm --filter @vibelingan-channel/site dev:assistant-preview --port 62058',
      url: 'http://127.0.0.1:62058/assistant-chat.html',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});

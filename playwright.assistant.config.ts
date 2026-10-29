import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/assistant-ui',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 20000,
  expect: { timeout: 5000 },
  outputDir: 'output/assistant-ui/test-results',
  reporter: [['list'], ['json', { outputFile: 'output/assistant-ui/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:62058',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @vibelingan-channel/site dev:assistant-preview --port 62058',
    url: 'http://127.0.0.1:62058/assistant-preview.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});

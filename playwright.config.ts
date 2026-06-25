import { defineConfig, devices } from '@playwright/test';

const siteUrl = process.env.E2E_SITE_URL?.replace(/\/+$/, '') ?? 'http://localhost:4321';
const recordArtifacts =
  process.env.E2E_RECORD_ARTIFACTS === '1' ||
  process.env.E2E_RECORD_ARTIFACTS?.toLowerCase() === 'true';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: 'output/playwright/test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'output/playwright/report' }],
    ...(process.env.CI
      ? ([['junit', { outputFile: 'output/playwright/e2e-junit.xml' }]] as const)
      : []),
  ],
  use: {
    baseURL: siteUrl,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    screenshot: recordArtifacts ? 'only-on-failure' : 'off',
    trace: recordArtifacts ? 'retain-on-failure' : 'off',
    video: recordArtifacts ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

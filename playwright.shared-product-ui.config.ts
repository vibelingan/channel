import { defineConfig, devices } from '@playwright/test';

if (process.env.E2E_SHARED_UI_ACCEPTANCE !== '1')
  throw new Error('Set E2E_SHARED_UI_ACCEPTANCE=1 for isolated local acceptance.');
process.env.E2E_SHARED_DETAIL_PREVIEW = '1';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'shared-catalog-navigation.spec.ts',
    'shared-detail-preview.spec.ts',
    'shared-product-journey.spec.ts',
  ],
  grepInvert: /local inquiry explicitly saves/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  outputDir: 'output/playwright/cui08-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4328',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1024 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 } },
    },
  ],
});

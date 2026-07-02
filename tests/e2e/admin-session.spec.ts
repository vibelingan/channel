import { expect, test } from '@playwright/test';

const unauthorized = {
  ok: false,
  error: { code: 'UNAUTHORIZED', message: 'Invalid email or password.' },
} as const;

test.describe('admin session expiry handling', () => {
  test('stale admin token redirects to login instead of rendering a 401 table error', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('channel.token', 'expired-token');
      localStorage.setItem(
        'channel.user',
        JSON.stringify({
          id: 'user-1',
          email: 'admin@example.test',
          username: 'Admin',
          role: 'admin',
          status: 'active',
        }),
      );
    });

    await page.route('**/api/admin', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        }),
      });
    });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/login\?returnTo=\/admin$/);
    await expect(page.getByText(/Request failed \(401\)/i)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('channel.token'))).toBeNull();
  });

  test('login 401 remains an inline form error', async ({ page }) => {
    await page.route('**/api/admin', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify(unauthorized),
      });
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.locator('astro-island[component-export="AuthForm"]:not([ssr])').waitFor();
    await page.getByLabel('Email').fill('admin@example.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Invalid email or password.')).toBeVisible();
  });
});

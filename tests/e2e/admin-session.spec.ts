import { type Page, expect, test } from '@playwright/test';

const unauthorized = {
  ok: false,
  error: { code: 'UNAUTHORIZED', message: 'Invalid email or password.' },
} as const;

const adminUser = {
  id: 'user-1',
  email: 'admin@example.test',
  username: 'Admin',
  role: 'admin',
} as const;

async function seedAdminSession(page: Page, token = 'valid-token') {
  await page.addInitScript(
    ({ seedToken, user }) => {
      localStorage.setItem('channel.token', seedToken);
      localStorage.setItem('channel.user', JSON.stringify(user));
    },
    { seedToken: token, user: adminUser },
  );
}

test.describe('admin session expiry handling', () => {
  test('valid admin token verifies with the API and renders the dashboard', async ({ page }) => {
    await seedAdminSession(page);

    await page.route('**/api/admin', async (route) => {
      const body = route.request().postDataJSON() as { action?: string; data?: unknown };
      if (body.action === 'me') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { user: adminUser } }),
        });
        return;
      }
      if (body.action === 'list') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            data: { items: [], total: 0, page: 1, pageSize: 10 },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'BAD_REQUEST', message: `Unexpected action: ${body.action}` },
        }),
      });
    });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText('Channel Admin')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByText('Request failed (401)')).toHaveCount(0);
  });

  test('stale admin token redirects to login instead of rendering a 401 table error', async ({
    page,
  }) => {
    await seedAdminSession(page, 'expired-token');

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

  test('deleted account during session verification redirects to login', async ({ page }) => {
    await seedAdminSession(page);

    await page.route('**/api/admin', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Account not found.' },
        }),
      });
    });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/login\?returnTo=\/admin$/);
    await expect(page.getByText('Session check failed')).toHaveCount(0);
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

import { expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { hasAdminCredentials } from './helpers/env';

test.describe('admin authenticated smoke', () => {
  test.skip(!hasAdminCredentials(), 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run admin e2e.');

  test('admin API login can list at least the users collection', async ({ request }) => {
    const session = await loginAdmin(request);
    expect(session.user.role).toBe('admin');

    const users = await adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      { collection: 'users', page: 1, pageSize: 1 },
      session.token,
    );
    expect(Array.isArray(users.items)).toBe(true);
    expect(users.total).toBeGreaterThanOrEqual(1);
  });

  test('admin can sign in through the browser and reach dashboard navigation', async ({ page }) => {
    await page.goto('/login?returnTo=/admin', { waitUntil: 'domcontentloaded' });
    await page.locator('astro-island[component-export="AuthForm"]:not([ssr])').waitFor();
    await page.getByLabel('Email').fill(process.env.E2E_ADMIN_EMAIL ?? '');
    await page.getByLabel('Password').fill(process.env.E2E_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/admin(?:$|\?)/);
    await expect(page.getByText('Channel Admin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Headphones' })).toBeVisible();
  });
});

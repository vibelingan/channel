import { type Page, expect } from '@playwright/test';

/** Login navigates immediately; inspect status and the new document, without retaining tokens or the old response body. */
export async function signInAdminThroughUi(page: Page, email: string, password: string) {
  if (!email || !password) throw Error('Administrator credentials required');
  await page.goto('/login?returnTo=/admin', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const reply = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin') &&
      response.request().postDataJSON()?.action === 'login',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await reply).status()).toBe(200);
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/admin');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const user = JSON.parse(localStorage.getItem('channel.user') ?? 'null');
        return user?.role;
      }),
    )
    .toBe('admin');
}

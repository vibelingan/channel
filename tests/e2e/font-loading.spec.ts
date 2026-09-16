import { type Route, expect, test } from '@playwright/test';

test('an unavailable font stylesheet does not block the public page or its navigation', async ({
  page,
}) => {
  const pendingFonts: Route[] = [];
  await page.route('https://fonts.googleapis.com/**', (route) => {
    // Only the external font transport is suspended. HTML, JS and API remain real.
    pendingFonts.push(route);
  });
  try {
    await page.goto('/', { waitUntil: 'load', timeout: 8_000 });
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(() => pendingFonts.length).toBeGreaterThan(0);
    const headphones = page.getByRole('link', { name: 'Headphones', exact: true }).first();
    await headphones.click();
    await expect(page).toHaveURL(/\/headphones\/?$/);
    await expect(page.getByRole('main')).toBeVisible();
  } finally {
    for (const route of pendingFonts) await route.abort();
  }
});

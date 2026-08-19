import { expect, test } from '@playwright/test';

const familyRoutes = [
  { path: '/headphones/', family: 'headphones', heading: 'OEM Headphones, Built for Your Brand' },
  { path: '/ai-gadgets/', family: 'ai-gadgets', heading: 'AI Gadgets' },
  { path: '/toys/', family: 'toys', heading: 'Toys' },
] as const;

for (const route of familyRoutes) {
  test(`${route.path} requests its family and renders the shared catalog shell`, async ({
    page,
  }) => {
    const requests: URL[] = [];
    await page.route('**/api/products*', async (requestRoute) => {
      requests.push(new URL(requestRoute.request().url()));
      await requestRoute.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { items: [], total: 0, page: 1, pageSize: 12 },
        }),
      });
    });

    for (const viewport of [
      { width: 375, height: 812 },
      { width: 1440, height: 900 },
    ]) {
      requests.length = 0;
      await page.setViewportSize(viewport);
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(`${route.path.replaceAll('/', '\\/')}$`),
      );
      await expect(
        page.locator('main p:not(.sr-only)', {
          hasText: 'No products match these filters.',
        }),
      ).toBeVisible();
      await expect
        .poll(() => requests.at(-1)?.searchParams.get('productFamily'))
        .toBe(route.family);
      expect(requests.at(-1)?.searchParams.get('page')).toBe('1');
      expect(requests.at(-1)?.searchParams.get('pageSize')).toBe('12');
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);
    }

    if (route.family === 'headphones') {
      await expect(page.getByRole('group', { name: 'Categories' })).toBeVisible();
      await expect(page.getByRole('checkbox')).toHaveCount(3);
      await expect(page.getByRole('link', { name: 'Start Your OEM Enquiry' })).toHaveAttribute(
        'href',
        '/#oem-inquiry',
      );
    } else {
      await expect(page.getByRole('group', { name: 'Categories' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Request a Quote' })).toHaveAttribute(
        'href',
        '/#oem-inquiry',
      );
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
        'Electronics & Toys',
      );
    }
  });
}

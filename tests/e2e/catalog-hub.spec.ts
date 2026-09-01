import { expect, test } from '@playwright/test';

const catalogPath = '**/api/products*';

const realProduct = {
  _id: 'product-1',
  name: 'VisionClip AI Camera',
  productFamily: 'ai-gadgets',
  slug: 'visionclip-ai-camera',
  skuCode: 'AI-VC-100',
  description: 'Compact smart camera for OEM programs.',
  moq: 100,
  images: ['/media/oem/process/p04.jpg'],
};

test('Featured Products moves through loading, error, retry, and real data', async ({ page }) => {
  let releaseFailures: (() => void) | undefined;
  let shouldSucceed = false;
  const failuresReleased = new Promise<void>((resolve) => {
    releaseFailures = resolve;
  });
  await page.route(catalogPath, async (route) => {
    if (!shouldSucceed) {
      await failuresReleased;
      await route.fulfill({ status: 500, body: 'failed' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            realProduct,
            { ...realProduct, _id: 'legacy-product', name: 'Legacy Product', slug: undefined },
          ],
          total: 2,
          page: 1,
          pageSize: 8,
        },
      }),
    });
  });

  await page.goto('/electronics-toys/');
  await expect(page.getByLabel('Loading products…')).toBeVisible();
  releaseFailures?.();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('We could not load this product family.');
  shouldSucceed = true;
  await alert.getByRole('button', { name: 'Try Again' }).click();
  const productLink = page.getByRole('link', { name: /VisionClip AI Camera/ });
  await expect(productLink).toBeVisible();
  await expect(productLink).toHaveAttribute('href', '/products/item/?slug=visionclip-ai-camera');
  await expect(productLink).toContainText('AI-VC-100');
  await expect(productLink).toContainText('MOQ 100');
  await expect(page.getByRole('link', { name: /Legacy Product/ })).toHaveCount(0);
  await expect(page.locator('main a[href$="?slug="]')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/VIP|video/i);
});

test('hub renders four family destinations, one H1, empty state, CTA, and no overflow', async ({
  page,
}) => {
  await page.route(catalogPath, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { items: [], total: 0, page: 1, pageSize: 8 },
      }),
    }),
  );

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/electronics-toys/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Request a Quote' })).toHaveAttribute(
      'href',
      '/#oem-inquiry',
    );
    const destinations = await page
      .getByRole('region', { name: 'Electronics & Toys' })
      .locator('a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(destinations).toEqual(['/headphones/', '/ai-gadgets/', '/toys/', '/misc/']);
    await expect(page.locator('main .sr-only[aria-live="polite"]')).toHaveCount(1);
    await expect(
      page.locator('main p:not(.sr-only)', {
        hasText: 'Published products will appear here as they become available.',
      }),
    ).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      title: document.title.length,
      description:
        document.querySelector('meta[name="description"]')?.getAttribute('content')?.length ?? 0,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.title).toBeLessThanOrEqual(60);
    expect(dimensions.description).toBeLessThanOrEqual(160);
  }
});

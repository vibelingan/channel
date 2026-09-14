import { expect, test } from '@playwright/test';

const product = {
  _id: 'current',
  name: 'VisionClip AI Camera',
  productFamily: 'ai-gadgets',
  slug: 'visionclip-ai-camera',
  skuCode: 'AI-VC-100',
  description: 'Compact smart camera for OEM programs.',
  moq: 100,
  wholesalePrice: 15.5,
  vipPrice: 13.2,
  images: Array.from({ length: 10 }, (_, index) => `/media/test-${index + 1}.jpg`),
};

const related = {
  _id: 'related',
  name: 'Pocket Translator',
  productFamily: 'ai-gadgets',
  slug: 'pocket-translator',
  images: [],
};

const tieredToy = {
  _id: 'tiered-toy',
  name: 'Interactive Tiered Toy',
  productFamily: 'toys',
  slug: 'interactive-tiered-toy',
  description: 'Interactive toy for quantity-based OEM orders.',
  moq: 1,
  unitPrice: 134.18,
  wholesalePrice: 118.31,
  manualCatalogPricing: {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [
      { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
      { minQuantity: 13, unitAmountMinor: 11_831 },
    ],
  },
  images: ['/media/section-capabilities.png'],
};

const envelope = (data: unknown) => JSON.stringify({ ok: true, data });

test('direct SKU journey renders nine images, facts, related links, and preserves browser Back', async ({
  page,
}) => {
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) }),
  );
  await page.route('**/api/products?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [product, related], total: 2, page: 1, pageSize: 5 }),
    }),
  );

  await page.goto('/ai-gadgets/');
  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/\?slug=visionclip-ai-camera$/,
  );
  await expect(page.getByText('AI-VC-100', { exact: true })).toBeVisible();
  await expect(page.locator('dl > div', { hasText: 'MOQ' })).toContainText('100');
  await expect(page.getByText('$15.50', { exact: true })).toBeVisible();
  await expect(page.getByText('$13.20', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'View All' })).toBeVisible();
  await page.getByRole('button', { name: 'View All' }).click();
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(9);
  await expect(page.locator('img[src*="test-10"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Pocket Translator/ })).toHaveAttribute(
    'href',
    '/products/item/?slug=pocket-translator',
  );
  await expect(page.getByText(/VIP|video/i)).toHaveCount(0);
  const schemas = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts
        .map((script) => JSON.parse(script.textContent ?? '{}'))
        .flatMap((schema) => schema['@graph'] ?? []),
    );
  const breadcrumbSchema = schemas.find((node) => node['@type'] === 'BreadcrumbList');
  const productSchema = schemas.find((node) => node['@type'] === 'Product');
  const visibleBreadcrumbs = await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .locator('a, [aria-current="page"]')
    .allTextContents();
  expect(
    breadcrumbSchema.itemListElement.map(
      (item: { name: string; position: number; item: string }) => ({
        name: item.name,
        position: item.position,
        item: new URL(item.item).pathname + new URL(item.item).search,
      }),
    ),
  ).toEqual(
    visibleBreadcrumbs.map((name, index) => ({
      name: name.trim(),
      position: index + 1,
      item:
        index === 0
          ? '/'
          : index === 1
            ? '/electronics-toys/'
            : index === 2
              ? '/ai-gadgets/'
              : '/products/item/?slug=visionclip-ai-camera',
    })),
  );
  expect(productSchema).toMatchObject({
    '@type': 'Product',
    name: product.name,
    sku: product.skuCode,
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: '15.50' },
  });
  for (const forbidden of [
    'aggregateRating',
    'review',
    'inventoryLevel',
    'warranty',
    'availability',
  ]) {
    expect(productSchema).not.toHaveProperty(forbidden);
  }
  expect(page.url()).toContain('?slug=visionclip-ai-camera');
  await page.goBack();
  await expect(page).toHaveURL(/\/ai-gadgets\/$/);
});

test('missing and unknown slugs render not-found without detail', async ({ page }) => {
  await page.route('**/api/products/slug/unknown', (route) => route.fulfill({ status: 404 }));

  await page.goto('/products/item/');
  await expect(page.getByRole('heading', { level: 1, name: 'Product not found.' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await expect(page.locator('[data-sku-detail]')).toHaveCount(0);

  await page.goto('/products/item/?slug=unknown');
  await expect(page.getByRole('heading', { level: 1, name: 'Product not found.' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await expect(page.locator('[data-sku-detail]')).toHaveCount(0);
});

test('manual tiers drive card, in-page detail, slug detail, and AggregateOffer without SKU', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const productRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/products/slug/interactive-tiered-toy', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(tieredToy) }),
  );
  await page.route('**/api/products?*', (route) => {
    productRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [tieredToy], total: 1, page: 1, pageSize: 12 }),
    });
  });

  await page.goto('/toys/');
  await expect.poll(() => productRequests.length + pageErrors.length).toBeGreaterThan(0);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  const familyRequest = new URL(productRequests[0] ?? 'http://invalid');
  expect(familyRequest.searchParams.get('productFamily')).toBe('toys');
  expect(familyRequest.searchParams.get('page')).toBe('1');
  expect(familyRequest.searchParams.get('pageSize')).toBe('12');
  await expect(page.locator('[data-product-card-price]')).toHaveText('From $118.31');
  await page.getByRole('button', { name: /Interactive Tiered Toy/ }).click();
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('1–12');
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('13+');
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('$134.18');
  await expect(page.getByText('$118.31', { exact: true })).toBeVisible();
  await expect(page.getByText('$134.18', { exact: true })).toBeVisible();

  await page.goto('/products/item/?slug=interactive-tiered-toy');
  await expect(page.getByRole('heading', { level: 1, name: tieredToy.name })).toBeVisible();
  await expect(page.getByText('SKU', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('1–12');
  const productSchema = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts
        .map((script) => JSON.parse(script.textContent ?? '{}'))
        .flatMap((schema) => schema['@graph'] ?? [])
        .find((node) => node['@type'] === 'Product'),
    );
  expect(productSchema).not.toHaveProperty('sku');
  expect(productSchema.offers).toMatchObject({
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '118.31',
    highPrice: '134.18',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  if (process.env.E2E_RECORD_ARTIFACTS) {
    await page.screenshot({
      path: 'output/playwright/miu28-tiered-product-mobile.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: 'output/playwright/miu28-tiered-product-desktop.png',
      fullPage: true,
    });
  }
});

test('retry recovers from a detail transport error', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 500 })
      : route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) });
  });
  await page.route('**/api/products?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [], total: 0, page: 1, pageSize: 5 }),
    }),
  );

  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('alert')).toContainText('We could not load this product family.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/\?slug=visionclip-ai-camera$/,
  );
  expect(attempts).toBe(2);
});

test('related-product failure leaves the loaded detail usable', async ({ page }) => {
  let releaseRelated: (() => void) | undefined;
  const relatedReleased = new Promise<void>((resolve) => {
    releaseRelated = resolve;
  });
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) }),
  );
  await page.route('**/api/products?*', async (route) => {
    await relatedReleased;
    await route.fulfill({ status: 500 });
  });

  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('[data-sku-detail="current"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Build This Product for Your Market' }),
  ).toBeVisible();
  releaseRelated?.();
  await expect(page.getByRole('heading', { name: 'Related Products' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_SHARED_DETAIL_PREVIEW !== '1', 'Requires the isolated local preview');
const productId = '24ee8f21-1cac-49f0-93a2-30ba1746289f';
const variantId = '3cb695af-2fc5-4796-b345-3ba2c6a82fe1';
const listUrl = '/headphones/?preview=shared';
const cardSelector = `[data-product-card="${productId}"]`;
const detailSelector = `[data-shared-catalog-detail="${productId}"]`;

test.beforeEach(async ({ baseURL, page }) => {
  expect(baseURL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)).toBe(
    true,
  );
  // Navigation acceptance is strictly read-only, even if an accidental submit is introduced.
  await page.route('**/api/**', (route) =>
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) &&
    ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
      ? route.fallback()
      : route.abort(),
  );
});

test('real list search -> detail -> back/forward retains focus, scroll, configuration and in-detail quantity', async ({
  page,
}) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url());
  });
  await page.goto(listUrl);
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('Wireless Earphones');
  const card = page.locator(cardSelector);
  await expect(page.locator('[data-result-progress]')).toHaveText('1 products');
  await card.scrollIntoViewIfNeeded();
  const scrollY = await page.evaluate(() => window.scrollY);
  await card.click();
  await expect(page.locator(detailSelector)).toBeVisible();
  await expect(page.locator('[data-shared-detail-heading]')).toBeFocused();
  const back = page.getByRole('button', { name: 'Back to catalog', exact: true });
  await expect(back).toBeInViewport();
  const backBox = await back.boundingBox();
  expect(backBox?.y).toBeGreaterThanOrEqual(72);
  const quantity = page.getByRole('textbox', { name: 'Requested quantity', exact: true });
  await quantity.fill('500');
  await page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }).check();
  await expect(quantity).toHaveValue('500');
  expect(new URL(page.url()).searchParams.get('variant')).toBe(variantId);
  await back.click();
  await expect(card).toBeFocused();
  await expect(search).toHaveValue('Wireless Earphones');
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY)).toBeLessThanOrEqual(2);
  await page.goForward();
  await expect(
    page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }),
  ).toBeChecked();
  await page.goBack();
  await expect(card).toBeFocused();
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test('a loaded second page and non-default category filter survive return without a new list request', async ({
  page,
}) => {
  // Capture the UI's configured API, not the site proxy (which may serve a different local DB).
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/products',
  );
  await page.goto(listUrl);
  const response = await pending;
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  const product = envelope.data.items.find((item: { _id: string }) => item._id === productId);
  expect(product).toBeTruthy();
  // Controlled pagination boundary fixture, not 13 claimed database records.
  const rows = Array.from({ length: 12 }, (_, index) => ({
    ...product,
    _id: `pagination-fixture-${index}`,
    name: `Pagination fixture ${index}`,
    category: 'wired',
  }));
  rows.push({ ...product, category: 'wired' });
  const queries: string[] = [];
  await page.route('**/api/products?*', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    const number = Number(url.searchParams.get('page'));
    await route.fulfill({
      json: {
        ok: true,
        data: {
          items: rows.slice((number - 1) * 12, number * 12),
          total: 13,
          page: number,
          pageSize: 12,
        },
      },
    });
  });
  await page.goto(listUrl);
  await expect(page.locator('[data-product-card]')).toHaveCount(12);
  await page.getByRole('checkbox', { name: 'Office Headphones', exact: true }).uncheck();
  await expect.poll(() => queries.at(-1)).toContain('category=wired%2Cbluetooth');
  await expect(page.locator('[data-product-card]')).toHaveCount(12);
  await page.locator('[data-load-more]').click();
  await expect(page.locator('[data-product-card]')).toHaveCount(13);
  expect(queries.at(-1)).toContain('page=2');
  const count = queries.length;
  await page.locator(cardSelector).click();
  await expect(page.locator(detailSelector)).toBeVisible();
  await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
  await expect(page.locator(cardSelector)).toBeFocused();
  await expect(
    page.getByRole('checkbox', { name: 'Office Headphones', exact: true }),
  ).not.toBeChecked();
  await expect(page.locator('[data-product-card]')).toHaveCount(13);
  await expect(page.locator('[data-load-more]')).toHaveCount(0);
  expect(queries.length).toBe(count);
});

test('closing a loading detail prevents its delayed real response reopening the page', async ({
  page,
}) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalStarted = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  await page.route(`**/api/products/${productId}/detail?*`, async (route) => {
    const response = await route.fetch();
    signalStarted();
    await waiting;
    await route.fulfill({ response });
  });
  try {
    await page.goto(listUrl);
    await page.locator(cardSelector).click();
    await started;
    await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
    await expect(page.locator(cardSelector)).toBeFocused();
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('[data-shared-detail-navigation]')).toHaveCount(0);
    await expect(page.locator('[data-shared-catalog-detail]')).toHaveCount(0);
    await expect(page.locator(cardSelector)).toBeVisible();
    expect(new URL(page.url()).searchParams.has('id')).toBe(false);
  } finally {
    release();
  }
});

test('category-independent deep links reload canonical selection and fresh Back stays within the site', async ({
  page,
}) => {
  await page.goto(`/misc/?preview=shared&id=${productId}&variant=${variantId}`);
  await expect(page.locator(detailSelector)).toBeVisible();
  await expect(
    page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }),
  ).toBeChecked();
  await page.reload();
  await expect(
    page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
  await expect(page.locator('[data-shared-catalog-list]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/misc/');
  expect(new URL(page.url()).search).toBe('?preview=shared');
  await page.goto(`/products/item/?preview=shared&id=${productId}&variant=${variantId}`);
  await expect(
    page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }),
  ).toBeChecked();
});

test('invalid preview URLs and missing details can return to the list without opening a legacy detail', async ({
  page,
}) => {
  for (const query of ['?preview=shared&id=x&slug=y', '?preview=wrong']) {
    await page.goto(`/headphones/${query}`);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('[data-product-detail], [data-shared-catalog-detail]')).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
    await expect(page.locator(cardSelector)).toBeVisible();
  }
  await page.goto('/headphones/?preview=shared&id=missing-cui07-product');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
  await expect(page.locator(cardSelector)).toBeVisible();
});

test('ordinary local category routes still open the old detail with no shared navigation', async ({
  page,
}) => {
  await page.goto('/headphones/');
  await page.locator(cardSelector).click();
  await expect(page.locator(`[data-product-detail="${productId}"]`)).toBeVisible();
  await expect(
    page.locator('[data-shared-detail-navigation], [data-shared-catalog-detail]'),
  ).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
});

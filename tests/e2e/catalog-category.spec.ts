import { expect, test } from '@playwright/test';

const catalogPaths = [
  '/electronics-toys/',
  '/headphones/',
  '/ai-gadgets/',
  '/toys/',
  '/misc/',
] as const;

test('catalog destinations remain usable with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();

  try {
    await page.goto('/');
    const mobileMenu = page.locator('[data-mobile-disclosure]');
    await mobileMenu.locator(':scope > summary').click();
    const catalogMenu = mobileMenu.locator('[data-catalog-disclosure="mobile"]');
    await catalogMenu.locator(':scope > summary').click();
    const links = catalogMenu.locator('[data-catalog-menu] a');
    await expect(links).toHaveCount(catalogPaths.length);
    expect(
      await links.evaluateAll((items) => items.map((item) => item.getAttribute('href'))),
    ).toEqual(catalogPaths);
    await links.filter({ hasText: 'AI Gadgets' }).click();
    await expect(page).toHaveURL(/\/ai-gadgets\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'AI Gadgets' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('catalog loading motion is disabled for reduced-motion users', async ({ browser }) => {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 375, height: 812 },
  });
  const page = await context.newPage();
  let releaseCatalog: (() => void) | undefined;
  const catalogReleased = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route('**/api/products*', async (route) => {
    await catalogReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { items: [], total: 0, page: 1, pageSize: 12 } }),
    });
  });

  try {
    await page.goto('/ai-gadgets/');
    const skeleton = page.locator('.animate-pulse').first();
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveCSS('animation-name', 'none');
    releaseCatalog?.();
    await expect(
      page.locator('main p:not(.sr-only)', { hasText: 'No products match these filters.' }),
    ).toBeVisible();
  } finally {
    releaseCatalog?.();
    await context.close();
  }
});

test('Headphones filters compose with pagination and reset loaded pages', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/products*', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const category = url.searchParams.get('category');
    const filtered = category === 'wired,bluetooth';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              _id: filtered ? 'filtered' : `page-${pageNumber}`,
              name: filtered ? 'Filtered Headphones' : `Headphones Page ${pageNumber}`,
              slug: filtered ? 'filtered-headphones' : `headphones-page-${pageNumber}`,
              productFamily: 'headphones',
              category: filtered ? 'wired' : 'office',
              images: [],
            },
          ],
          total: filtered ? 1 : 2,
          page: pageNumber,
          pageSize: 12,
        },
      }),
    });
  });

  await page.goto('/headphones/');
  await expect(page.getByText('Headphones Page 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load More' }).click();
  await expect(page.getByText('Headphones Page 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Headphones Page 1', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get('page')).toBe('2');
  expect(requests.at(-1)?.searchParams.get('productFamily')).toBe('headphones');
  expect(requests.at(-1)?.searchParams.get('category')).toBeNull();

  await page.getByRole('checkbox', { name: 'Office Headphones' }).uncheck();
  await expect(page.getByText('Filtered Headphones', { exact: true })).toBeVisible();
  await expect(page.getByText('Headphones Page 2', { exact: true })).toHaveCount(0);
  expect(requests.at(-1)?.searchParams.get('page')).toBe('1');
  expect(requests.at(-1)?.searchParams.get('productFamily')).toBe('headphones');
  expect(requests.at(-1)?.searchParams.get('category')).toBe('wired,bluetooth');
  expect(
    requests.every((request) => request.searchParams.get('productFamily') === 'headphones'),
  ).toBe(true);
});

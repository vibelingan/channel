import { type Page, expect, test } from '@playwright/test';
import type {
  CatalogPage,
  Product,
  ProductFamily,
} from '../../apps/site/src/islands/shop/catalog-types.ts';

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

const families = ['headphones', 'ai-gadgets', 'toys', 'misc'] as const;

function productFixture(
  family: ProductFamily,
  index: number,
  overrides: Partial<Product> = {},
): Product {
  return {
    _id: `${family}-${index}`,
    name: `Catalog ${family} ${String(index).padStart(2, '0')}`,
    productFamily: family,
    ...(family === 'headphones' ? { category: 'wired' } : {}),
    images: [],
    ...overrides,
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function mockCatalog(
  page: Page,
  family: ProductFamily,
  beforeReply?: (url: URL) => Promise<boolean>,
) {
  const requests: URL[] = [];
  let detailRequested = false;
  const products = Array.from({ length: 25 }, (_, index) => productFixture(family, index + 1));
  await page.route('**/api/products?*', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('productFamily')).toBe(family);
    if (url.searchParams.get('pageSize') === '5') {
      expect(detailRequested).toBe(true);
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.has('search')).toBe(false);
      const data: CatalogPage = { items: products.slice(0, 5), total: 25, page: 1, pageSize: 5 };
      await route.fulfill({ json: { ok: true, data } });
      return;
    }
    requests.push(url);
    expect(url.searchParams.get('pageSize')).toBe('12');
    if (await beforeReply?.(url)) {
      await route.fulfill({ status: 500, body: 'Controlled catalog failure' });
      return;
    }
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const category = url.searchParams.get('category');
    const search = url.searchParams.get('search')?.toLowerCase() ?? '';
    const filtered = products.filter(
      (product) =>
        product.name.toLowerCase().includes(search) &&
        (category === null || category.split(',').includes(product.category ?? '')),
    );
    const data: CatalogPage = {
      items: filtered.slice((pageNumber - 1) * 12, pageNumber * 12),
      total: filtered.length,
      page: pageNumber,
      pageSize: 12,
    };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.route(`**/api/products/${family}-*`, async (route) => {
    detailRequested = true;
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/detail')) {
      await route.fulfill({ status: 404, json: { ok: false, error: { code: 'NOT_FOUND' } } });
      return;
    }
    const product = products.find((candidate) => candidate._id === pathname.split('/').at(-1));
    await route.fulfill({
      status: product ? 200 : 404,
      json: product ? { ok: true, data: product } : { ok: false },
    });
  });
  return requests;
}

async function expectPage(page: Page, family: ProductFamily, number: number) {
  const start = (number - 1) * 12 + 1;
  const end = Math.min(number * 12, 25);
  await expect(page.locator('[data-product-card]')).toHaveCount(end - start + 1);
  await expect(page.locator('[data-product-card]').first()).toHaveAttribute(
    'data-product-card',
    `${family}-${start}`,
  );
  await expect(page.locator('[data-product-card]').last()).toHaveAttribute(
    'data-product-card',
    `${family}-${end}`,
  );
  await expect(page.locator('[data-result-progress]')).toHaveText(
    `${start}\u2013${end} of 25 products`,
  );
  await expect(page.getByRole('button', { name: `Page ${number}`, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe(String(number));
}

for (const family of families) {
  test(`${family}: numbered pages replace twelve cards, reload deep URLs and follow Back/Forward`, async ({
    page,
  }) => {
    const requests = await mockCatalog(page, family);
    await page.goto(`/${family}/`);
    await expectPage(page, family, 1);
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expectPage(page, family, 2);
    await expect(page.locator(`[data-product-card="${family}-1"]`)).toHaveCount(0);
    await expect(page.locator('[data-catalog-list-top]')).toBeFocused();
    await page.getByRole('button', { name: 'Page 3', exact: true }).click();
    await expectPage(page, family, 3);
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await page.reload();
    await expectPage(page, family, 3);
    expect(requests.at(-1)?.searchParams.get('page')).toBe('3');
    await page.goBack();
    await expectPage(page, family, 2);
    await page.goForward();
    await expectPage(page, family, 3);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expectPage(page, family, 2);
    await page.getByRole('searchbox', { name: 'Search products' }).fill('Catalog');
    await expectPage(page, family, 1);
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('Catalog');
    expect(requests.at(-1)?.searchParams.get('search')).toBe('Catalog');
    await page.reload();
    await expectPage(page, family, 1);
    await expect(page.getByRole('searchbox')).toHaveValue('Catalog');
  });

  test(`${family}: page-two detail returns focus without losing cards or refetching the list`, async ({
    page,
  }) => {
    const requests = await mockCatalog(page, family);
    await page.goto(`/${family}/?page=2&search=Catalog`);
    await expectPage(page, family, 2);
    const count = requests.length;
    const origin = page.locator(`[data-product-card="${family}-13"]`);
    await origin.click();
    await expect(page.locator('[data-product-detail], [data-shared-catalog-detail]')).toBeVisible();
    await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
    await expect(origin).toBeFocused();
    await expectPage(page, family, 2);
    await expect(page.getByRole('searchbox')).toHaveValue('Catalog');
    expect(requests).toHaveLength(count);
  });
}

test('Headphones category and search reset page one; no selected categories stays empty across reload', async ({
  page,
}) => {
  const requests = await mockCatalog(page, 'headphones');
  await page.goto('/headphones/?page=2&search=Catalog');
  await expectPage(page, 'headphones', 2);
  await page.getByRole('checkbox', { name: 'Office Headphones' }).uncheck();
  await expectPage(page, 'headphones', 1);
  expect(requests.at(-1)?.searchParams.get('category')).toBe('bluetooth,wired');
  await expect.poll(() => new URL(page.url()).searchParams.get('category')).toBe('bluetooth,wired');
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expectPage(page, 'headphones', 2);
  await page.getByRole('searchbox').fill('25');
  await expect(page.locator('[data-product-card]')).toHaveCount(1);
  await expect(page.locator('[data-result-progress]')).toHaveText('1\u20131 of 1 products');
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('1');
  await page.getByRole('searchbox').fill('');
  await expectPage(page, 'headphones', 1);
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
  await expect(page.locator('[data-product-card]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('category')).toBe('__none__');
  const count = requests.length;
  await page.reload();
  await expect(page.getByText('No products match these filters.', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0);
  expect(requests).toHaveLength(count);
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
  await expectPage(page, 'headphones', 1);
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
  expect(requests.at(-1)?.searchParams.has('category')).toBe(false);
});

test('page-two failure retains page-one URL and clickable cards; retry replaces the page', async ({
  page,
}) => {
  const release = deferred();
  const started = deferred();
  let fail = true;
  const requests = await mockCatalog(page, 'headphones', async (url) => {
    if (url.searchParams.get('page') !== '2' || !fail) return false;
    fail = false;
    started.resolve();
    await release.promise;
    return true;
  });
  try {
    await page.goto('/headphones/?page=1');
    await expectPage(page, 'headphones', 1);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await started.promise;
    const controls = page.getByRole('navigation', { name: 'Pagination' }).getByRole('button');
    for (const control of await controls.all()) await expect(control).toBeDisabled();
    release.resolve();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectPage(page, 'headphones', 1);
    const card = page.locator('[data-product-card="headphones-1"]');
    await expect(card).toBeEnabled();
    await page.getByRole('button', { name: 'Try Again', exact: true }).click();
    await expectPage(page, 'headphones', 2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(requests.filter((url) => url.searchParams.get('page') === '2')).toHaveLength(2);
  } finally {
    release.resolve();
  }
});

test('history Back failure keeps the desired page URL with an error instead of rewriting the previous URL', async ({
  page,
}) => {
  let failBack = false;
  await mockCatalog(
    page,
    'headphones',
    async (url) => failBack && url.searchParams.get('page') === '2',
  );
  await page.goto('/headphones/?page=1');
  await expectPage(page, 'headphones', 1);
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expectPage(page, 'headphones', 2);
  await page.getByRole('button', { name: 'Page 3', exact: true }).click();
  await expectPage(page, 'headphones', 3);
  failBack = true;
  await page.goBack();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-product-card]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  failBack = false;
  await page.getByRole('button', { name: 'Try Again', exact: true }).click();
  await expectPage(page, 'headphones', 2);
});

test('history Back supersedes a matching pending page click when both requests fail', async ({
  page,
}) => {
  const release = deferred();
  let pageTwoRequests = 0;
  let fail = true;
  await mockCatalog(page, 'headphones', async (url) => {
    if (url.searchParams.get('page') !== '2') return false;
    pageTwoRequests += 1;
    if (pageTwoRequests === 1 || !fail) return false;
    await release.promise;
    return true;
  });
  try {
    await page.goto('/headphones/?page=1');
    await expectPage(page, 'headphones', 1);
    await page.getByRole('button', { name: 'Page 2', exact: true }).click();
    await expectPage(page, 'headphones', 2);
    await page.getByRole('button', { name: 'Page 3', exact: true }).click();
    await expectPage(page, 'headphones', 3);
    await page.getByRole('button', { name: 'Page 2', exact: true }).click();
    await expect.poll(() => pageTwoRequests).toBe(2);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    release.resolve();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    await expect(page.locator('[data-product-card]')).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Try Again', exact: true }).click();
    await expectPage(page, 'headphones', 2);
    expect(pageTwoRequests).toBe(4);
  } finally {
    release.resolve();
  }
});

test('fresh detail deep link closes onto the recovered last catalog page', async ({ page }) => {
  const requests = await mockCatalog(page, 'headphones');
  await page.goto('/headphones/?page=99&id=headphones-13');
  const hiddenList = page.locator('[data-shared-catalog-list]');
  await expect(hiddenList).toBeHidden();
  await expect(hiddenList.locator('[data-product-card]')).toHaveCount(1);
  await expect(hiddenList.locator('[data-product-card]')).toHaveAttribute(
    'data-product-card',
    'headphones-25',
  );
  await expect(page.locator('[data-product-detail], [data-shared-catalog-detail]')).toBeVisible();
  expect(requests.map((url) => url.searchParams.get('page'))).toEqual(['99', '3']);
  await page.getByRole('button', { name: 'Back to catalog', exact: true }).click();
  await expect(hiddenList).toBeVisible();
  await expectPage(page, 'headphones', 3);
  expect(new URL(page.url()).searchParams.has('id')).toBe(false);
});

test('rapid search changes and A-B-A filters reject delayed responses', async ({ page }) => {
  const release = deferred();
  const started = deferred();
  await mockCatalog(page, 'headphones', async (url) => {
    if (url.searchParams.get('search') === 'Catalog') {
      started.resolve();
      await release.promise;
    }
    return false;
  });
  try {
    await page.goto('/headphones/?page=2');
    await expectPage(page, 'headphones', 2);
    await page.getByRole('searchbox').fill('Catalog');
    await started.promise;
    await page.getByRole('searchbox').fill('25');
    await expect(page.locator('[data-result-progress]')).toHaveText('1\u20131 of 1 products');
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('searchbox')).toHaveValue('25');
    await expect(page.locator('[data-product-card]')).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get('search')).toBe('25');
  } finally {
    release.resolve();
  }

  const releaseSecond = deferred();
  const startedSecond = deferred();
  await mockCatalog(page, 'headphones', async (url) => {
    if (url.searchParams.get('search') === '25') {
      startedSecond.resolve();
      await releaseSecond.promise;
    }
    return false;
  });
  try {
    await page.goto('/headphones/?page=1');
    await expectPage(page, 'headphones', 1);
    await page.getByRole('searchbox').fill('25');
    await startedSecond.promise;
    await page.getByRole('searchbox').fill('');
    await expectPage(page, 'headphones', 1);
    releaseSecond.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await expectPage(page, 'headphones', 1);
    await expect(page.getByRole('searchbox')).toHaveValue('');
  } finally {
    releaseSecond.resolve();
  }
});

for (const family of families) {
  test(`${family}: hostile or unknown category URLs never broaden into all products`, async ({
    page,
  }) => {
    const requests = await mockCatalog(page, family);
    for (const query of [
      'category=unknown',
      'category=wired,unknown',
      'category=wired&category=office',
      'category=%24ne',
      'category=',
    ]) {
      await page.goto(`/${family}/?page=2&${query}`);
      await expect(
        page.getByText('No products match these filters.', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('[data-product-card]')).toHaveCount(0);
      expect(requests).toHaveLength(0);
      expect(new URL(page.url()).searchParams.get('category')).toBe('__none__');
    }
  });
}

for (const width of [320, 390, 1440]) {
  test(`numbered catalog screenshot and fallback-font footer geometry at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('https://fonts.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    await mockCatalog(page, 'headphones');
    await page.goto('/headphones/?page=1');
    await expectPage(page, 'headphones', 1);
    expect(await page.evaluate(() => window.innerWidth)).toBe(width);
    const pagination = page.getByRole('navigation', { name: 'Pagination' });
    await pagination.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const control of await pagination.getByRole('button').all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
    await page.screenshot({
      path: testInfo.outputPath(`catalog-${width}-page-1.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Page 3', exact: true }).click();
    await expectPage(page, 'headphones', 3);
    await pagination.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`catalog-${width}-page-3.png`),
      fullPage: true,
    });
  });
}

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { z } from 'zod';
import { expectPageAllowsIndexing } from './helpers/seo-indexability.ts';
const liveNetwork = new WeakMap<
  Page,
  { method: string; path: string; status?: number; failure?: string }[]
>();
const categoryPageSchema = z.object({
  family: z.enum(['headphones', 'ai-gadgets', 'toys', 'misc']),
  page: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  path: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  productIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(12),
});
async function verifyCategoryPages(page: Page, browser: Browser) {
  const site = process.env.E2E_SITE_URL ?? '';
  const manifestPath = '/catalog-pages/manifest.json';
  const reads = [manifestPath];
  const response = await page.request.get(manifestPath, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const manifest = z
    .object({
      schemaVersion: z.literal(1),
      purpose: z.literal('public'),
      siteOrigin: z.literal(site),
      pages: z.array(categoryPageSchema).min(4).max(50_000),
    })
    .parse(await response.json());
  for (const entry of manifest.pages)
    expect(entry.path).toBe(`/${entry.family}/${entry.page === 1 ? '' : `page/${entry.page}/`}`);
  const roots = ['headphones', 'ai-gadgets', 'toys', 'misc'].map((family) => {
    const matching = manifest.pages.filter((entry) => entry.family === family && entry.page === 1);
    expect(matching, `One initial HTML page for ${family}`).toHaveLength(1);
    if (!matching[0]) throw Error(`Missing root category: ${family}`);
    return matching[0];
  });
  const second =
    manifest.pages.find((entry) => entry.family === 'headphones' && entry.page === 2) ??
    manifest.pages.find((entry) => entry.page === 2);
  const plain = await browser.newContext({ javaScriptEnabled: false });
  // Only document bytes are needed here; do not fetch up to 60 card images just
  // to prove those cards and links already exist before JavaScript runs.
  await plain.route('**/*', (route) =>
    route.request().resourceType() === 'document' ? route.continue() : route.abort(),
  );
  try {
    const html = await plain.newPage();
    for (const entry of [...roots, ...(second ? [second] : [])]) {
      reads.push(entry.path);
      const initial = await html.goto(`${site}${entry.path}`, { waitUntil: 'domcontentloaded' });
      expect(initial?.status(), entry.path).toBe(200);
      await expectPageAllowsIndexing(html, initial);
      await expect(html.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${site}${entry.path}`,
      );
      const cards = html.locator('main a[data-product-card]');
      expect(
        await cards.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-product-card')),
        ),
      ).toEqual(entry.productIds);
      expect(
        await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
      ).toEqual(entry.productIds.map((id) => `/products/p-${id}/`));
      for (const card of await cards.all())
        expect((await card.locator('h3').innerText()).trim().length).toBeGreaterThan(0);
      const pagination = html.getByRole('navigation', { name: 'Pagination', exact: true });
      for (const [label, number] of [
        ['Previous page', entry.page - 1],
        ['Next page', entry.page + 1],
      ] as const) {
        const neighbor = manifest.pages.find(
          (row) => row.family === entry.family && row.page === number,
        );
        const link = pagination.getByRole('link', { name: label, exact: true });
        if (neighbor) await expect(link).toHaveAttribute('href', neighbor.path);
        else await expect(link).toHaveCount(0);
      }
    }
  } finally {
    await plain.close();
  }
  if (second) {
    const first = roots.find((entry) => entry.family === second.family);
    expect(second.productIds.filter((id) => first?.productIds.includes(id))).toEqual([]);
  }
  const family = second?.family ?? 'headphones';
  const lastPage = Math.max(
    ...manifest.pages.filter((entry) => entry.family === family).map((entry) => entry.page),
  );
  for (const path of [`/${family}/page/1/`, `/${family}/page/${lastPage + 1}/`]) {
    reads.push(path);
    const missing = await page.request.get(path, { maxRedirects: 0 });
    expect(missing.status(), path).toBe(404);
    expect(await missing.text()).toContain('data-not-found-page');
  }
  if (second) {
    const waitForList = (number: number) =>
      page.waitForResponse((r) => {
        const url = new URL(r.url());
        return (
          [site, process.env.E2E_API_URL].includes(url.origin) &&
          r.request().method() === 'GET' &&
          url.pathname === '/api/products' &&
          url.searchParams.get('productFamily') === family &&
          url.searchParams.get('page') === String(number) &&
          url.searchParams.get('pageSize') === '12' &&
          r.status() === 200
        );
      });
    const refreshed = waitForList(2);
    reads.push(second.path);
    await page.goto(second.path, { waitUntil: 'domcontentloaded' });
    const latestResponse = await refreshed;
    // CDP can lose a consumed no-store/streaming body. The browser response
    // proves the real refresh; one independent GET supplies the current data.
    reads.push(latestResponse.url());
    const current = await page.request.get(latestResponse.url(), { maxRedirects: 0 });
    expect(current.status()).toBe(200);
    const latest = z
      .object({
        ok: z.literal(true),
        data: z.object({
          page: z.literal(2),
          pageSize: z.literal(12),
          items: z.array(z.object({ _id: z.string(), name: z.string().min(1) })).max(12),
        }),
      })
      .parse(await current.json());
    const ids = latest.data.items.map((item) => item._id);
    const expectSecond = async () => {
      await expect(page).toHaveURL(`${site}${second.path}`);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${site}${second.path}`,
      );
      await expect(
        page
          .getByRole('navigation', { name: 'Pagination', exact: true })
          .locator('[aria-current="page"]'),
      ).toHaveAttribute('aria-label', 'Page 2');
      await expect
        .poll(() =>
          page
            .locator('main a[data-product-card]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-product-card'))),
        )
        .toEqual(ids);
      await expect(page.locator('main a[data-product-card] h3')).toHaveText(
        latest.data.items.map((item) => item.name),
      );
      await expect(page.locator('[data-catalog-list-top] [role="alert"]')).toHaveCount(0);
    };
    await expectSecond();
    await mkdir('output/site-delivery/public-browser', { recursive: true });
    for (const [label, viewport] of [
      ['desktop', { width: 1440, height: 1100 }],
      ['mobile', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `output/site-delivery/public-browser/category-${label}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    const previous = roots.find((entry) => entry.family === family);
    if (!previous) throw Error('Missing first category page');
    const moved = waitForList(1);
    reads.push(previous.path);
    await page
      .getByRole('navigation', { name: 'Pagination', exact: true })
      .getByRole('link', { name: 'Previous page', exact: true })
      .click();
    await moved;
    await expect(page).toHaveURL(`${site}${previous.path}`);
    const returned = waitForList(2);
    reads.push(second.path);
    await page.goBack();
    await returned;
    await expectSecond();
  }
  expect(reads.length).toBeLessThanOrEqual(12);
  const result = {
    roots: roots.map(({ path, productIds }) => ({ path, productIds })),
    secondPage: second?.path ?? null,
    explicitReads: reads,
    maximumExplicitReads: 12,
  };
  await mkdir('output/site-delivery/public-browser', { recursive: true });
  await writeFile(
    'output/site-delivery/public-browser/category-result.json',
    JSON.stringify(result, null, 2),
  );
  return result;
}

test.skip(process.env.E2E_SEO_PUBLIC_LIVE !== '1', 'Explicit real-site read-only acceptance only.');
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(() => {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.E2E_SITE_URL !== 'https://supplychainsai.com' ||
    process.env.E2E_API_URL !== 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com'
  )
    throw Error('Unapproved live public target');
  if (!['static', 'server'].includes(process.env.E2E_BLOG_DELIVERY_MODE ?? ''))
    throw Error('The accepted Blog delivery mode is required');
  if (!['0', '1'].includes(process.env.E2E_REQUIRE_CATALOG_PAGES ?? '0'))
    throw Error('Invalid category-page acceptance mode');
});
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await mkdir('output/site-delivery/public-browser', { recursive: true });
  await page
    .screenshot({ path: 'output/site-delivery/public-browser/failure.png', fullPage: true })
    .catch(() => undefined);
  await writeFile(
    'output/site-delivery/public-browser/failure.json',
    JSON.stringify(
      {
        url: page.url(),
        errors: info.errors.map((e) => e.message),
        status: info.status,
        network: liveNetwork.get(page) ?? [],
      },
      null,
      2,
    ),
  );
});
test('real SSG HTML, latest browser API, gallery, category refresh, quote opening and Blog remain usable', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  const writes: string[] = [];
  const network: { method: string; path: string; status?: number; failure?: string }[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/'))
      network.push({
        method: r.request().method(),
        path: new URL(r.url()).pathname,
        status: r.status(),
      });
  });
  page.on('requestfailed', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/'))
      network.push({
        method: r.method(),
        path: new URL(r.url()).pathname,
        failure: r.failure()?.errorText ?? 'unknown',
      });
  });
  liveNetwork.set(page, network);

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (r) => {
    if (
      r.method() !== 'GET' &&
      r.method() !== 'HEAD' &&
      new URL(r.url()).pathname.startsWith('/api/')
    )
      writes.push(new URL(r.url()).pathname);
  });
  const response = await page.request.get('/products/manifest.json');
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest.purpose).toBe('public');
  expect(manifest.total).toBe(manifest.products.length);
  expect(manifest.total).toBeGreaterThan(0);
  const path = manifest.products[0].path;
  expect(path).toMatch(/^\/products\/p-[A-Za-z0-9_-]+\/$/);
  const id = path.split('/')[2].slice(2);
  const plain = await browser.newContext({ javaScriptEnabled: false });
  try {
    const html = await plain.newPage();
    const initial = await html.goto(`${process.env.E2E_SITE_URL}${path}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(html.locator('[data-shared-detail-heading]')).toBeVisible();
    expect((await html.locator('h1').innerText()).trim().length).toBeGreaterThan(0);
    await expect(html.locator('link[rel=canonical]')).toHaveAttribute(
      'href',
      `${process.env.E2E_SITE_URL}${path}`,
    );
    await expectPageAllowsIndexing(html, initial);
    const graphs = await html.locator('script[type="application/ld+json"]').allTextContents();
    // An enquiry product stays an ordinary indexed page until a truthful offer
    // or review can support Product rich results. Do not require invalid markup.
    const nodes = graphs.flatMap((text) => {
      const graph = JSON.parse(text);
      return Array.isArray(graph['@graph']) ? graph['@graph'] : [graph];
    });
    expect(nodes.some((node) => node['@type'] === 'WebPage')).toBe(true);
    expect(nodes.some((node) => node['@type'] === 'BreadcrumbList')).toBe(true);
    for (const node of nodes.filter((node) => node['@type'] === 'Product')) {
      expect(Boolean(node.offers || node.review || node.aggregateRating)).toBe(true);
    }
  } finally {
    await plain.close();
  }
  // CDP may discard no-store streaming bodies even after the page read them fully.
  // Compare the real API with the controller's post-validation state instead.
  const latestResponse = await page.request.get(
    `${process.env.E2E_API_URL}/api/products/${id}/detail?page=1&pageSize=50&view=sections-media&pagination=byte-budget-v1`,
  );
  expect(latestResponse.status()).toBe(200);
  const latest = await latestResponse.json();
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/products/${id}/detail` && r.status() === 200,
  );
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await refreshed;
  const applied = page.locator('[data-product-detail-freshness]');
  await expect(applied).toHaveAttribute('data-product-detail-freshness', 'fresh');
  await expect(applied).toHaveAttribute('data-product-detail-id', id);
  await expect(applied).toHaveAttribute('data-product-detail-revision', latest.data.revision);
  expect(latest.ok).toBe(true);
  expect(latest.data._id).toBe(id);
  await expect(page.locator('[data-shared-detail-heading]')).toHaveText(latest.data.name);
  const detail = page.locator('[data-shared-catalog-detail]');
  const thumbs = detail.locator('[data-gallery-thumbnail]');
  if ((await thumbs.count()) > 1) await thumbs.nth(1).click();
  const radios = detail.getByRole('radio');
  if (await radios.count()) await radios.first().check();
  else if (await detail.locator('select').count())
    await detail.locator('select').first().selectOption({ index: 1 });
  await expect(detail.locator('[data-quote-open]')).toBeEnabled();
  await detail.locator('[data-quote-open]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await mkdir('output/site-delivery/public-browser', { recursive: true });
  await page.screenshot({
    path: 'output/site-delivery/public-browser/product-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'output/site-delivery/public-browser/product-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const categoryAcceptance =
    process.env.E2E_REQUIRE_CATALOG_PAGES === '1' ? await verifyCategoryPages(page, browser) : null;
  if (!categoryAcceptance?.secondPage)
    await page.goto(
      categoryAcceptance?.roots.find((entry) => entry.productIds.length > 0)?.path ??
        '/headphones/',
      { waitUntil: 'domcontentloaded' },
    );
  const card = page.locator('a[href^="/products/p-"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('[data-shared-catalog-detail]')).toBeVisible();
  const reloaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/detail') && r.status() === 200,
  );
  await page.reload();
  await reloaded;
  await expect(page.locator('[data-product-detail-freshness]')).toHaveAttribute(
    'data-product-detail-freshness',
    'fresh',
  );
  await expect(page.locator('[data-shared-catalog-detail]')).toBeVisible();
  await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
  await expect(
    page.locator('[data-site-header]').getByRole('link', { name: 'Insights', exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Insights');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
    'href',
    'https://supplychainsai.com/blog/',
  );
  await page.screenshot({
    path: 'output/site-delivery/public-browser/blog-index-desktop.png',
    fullPage: true,
  });
  const articleLink = page.locator('main h2 a[href^="/blog/"]').first();
  const sampledArticle = (await articleLink.count())
    ? { path: await articleLink.getAttribute('href'), title: await articleLink.innerText() }
    : null;
  const articlePath = process.env.E2E_EXPECT_ARTICLE_PATH || sampledArticle?.path;
  const articleTitle = process.env.E2E_EXPECT_ARTICLE_PATH
    ? process.env.E2E_EXPECT_ARTICLE_TITLE
    : sampledArticle?.title;
  const serverBlog = process.env.E2E_BLOG_DELIVERY_MODE === 'server';
  const articleSitemapPath = serverBlog ? '/blog/sitemap.xml' : '/sitemap-0.xml';
  if (articlePath && process.env.E2E_EXPECT_ARTICLE_STATUS !== '404')
    await expect(page.locator(`main a[href="${articlePath}"]`)).toBeVisible();
  if (articlePath) {
    expect(articlePath).toMatch(/^\/blog\/[a-z0-9-]+\/$/);
    const article = await page.request.get(articlePath);
    const status = Number(process.env.E2E_EXPECT_ARTICLE_STATUS ?? '200');
    expect(article.status()).toBe(status);
    if (status === 404) {
      expect(await article.text()).toContain('data-not-found-page');
      const articleSitemap = await page.request.get(articleSitemapPath);
      expect(articleSitemap.status()).toBe(200);
      expect(await articleSitemap.text()).not.toContain(`https://supplychainsai.com${articlePath}`);
    } else {
      const articleResponse = await page.goto(articlePath, { waitUntil: 'domcontentloaded' });
      await expectPageAllowsIndexing(page, articleResponse);
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
        'href',
        `https://supplychainsai.com${articlePath}`,
      );
      await expect(page.locator('h1')).toHaveText(articleTitle ?? '');
      const articleSitemap = await page.request.get(articleSitemapPath);
      expect(articleSitemap.status()).toBe(200);
      expect(await articleSitemap.text()).toContain(`https://supplychainsai.com${articlePath}`);
      const images = await page.locator('.article-body img').evaluateAll((nodes) =>
        nodes.map((img) => ({
          src: img.getAttribute('src') ?? '',
          width: img.getAttribute('width'),
          height: img.getAttribute('height'),
          alt: img.getAttribute('alt'),
        })),
      );
      for (const image of images) {
        expect(image.src).toMatch(
          serverBlog
            ? /^\/blog\/media\/articles\/[A-Za-z0-9:_-]+\/[a-f0-9]{64}\.(jpg|png|webp)$/
            : /^\/media\/articles\/[A-Za-z0-9:_-]+\/[a-f0-9]{64}\.(jpg|png|webp)$/,
        );
        expect(Number(image.width)).toBeGreaterThan(0);
        expect(Number(image.height)).toBeGreaterThan(0);
        expect(image.alt).not.toBeNull();
        const bytes = await page.request.get(image.src);
        expect(bytes.status()).toBe(200);
        expect(
          createHash('sha256')
            .update(await bytes.body())
            .digest('hex'),
        ).toBe(image.src.split('/').at(-1)?.split('.')[0]);
      }
      for (const image of await page.locator('.article-body img').all()) {
        await image.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          )
          .toBe(true);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: 'output/site-delivery/public-browser/article-desktop.png',
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: 'output/site-delivery/public-browser/article-mobile.png',
        fullPage: true,
      });
    }
  }
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(
    'output/site-delivery/public-browser/result.json',
    JSON.stringify(
      {
        productPath: path,
        initialHtml: true,
        latestApi: true,
        categoryRefresh: true,
        categoryAcceptance,
        quoteOpened: true,
        businessWrites: writes.length,
        articlePath: articlePath ?? null,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
});

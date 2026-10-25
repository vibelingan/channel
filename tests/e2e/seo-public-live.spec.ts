import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import { expectPageAllowsIndexing } from './helpers/seo-indexability.ts';
const liveNetwork = new WeakMap<
  Page,
  { method: string; path: string; status?: number; failure?: string }[]
>();

test.skip(process.env.E2E_SEO_PUBLIC_LIVE !== '1', 'Explicit real-site read-only acceptance only.');
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(() => {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.E2E_SITE_URL !== 'https://supplychainsai.com' ||
    process.env.E2E_API_URL !== 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com'
  )
    throw Error('Unapproved live public target');
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
    expect(
      graphs.some((text) => JSON.stringify(JSON.parse(text)).includes('"@type":"Product"')),
    ).toBe(true);
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
  await page.goto('/headphones/', { waitUntil: 'domcontentloaded' });
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
  const articlePath = process.env.E2E_EXPECT_ARTICLE_PATH;
  if (articlePath && process.env.E2E_EXPECT_ARTICLE_STATUS !== '404')
    await expect(page.locator(`main a[href="${articlePath}"]`)).toBeVisible();
  if (articlePath) {
    expect(articlePath).toMatch(/^\/blog\/[a-z0-9-]+\/$/);
    const article = await page.request.get(articlePath);
    const status = Number(process.env.E2E_EXPECT_ARTICLE_STATUS ?? '200');
    expect(article.status()).toBe(status);
    if (status === 404) {
      expect(await article.text()).toContain('data-not-found-page');
      expect(await (await page.request.get('/sitemap-0.xml')).text()).not.toContain(
        `https://supplychainsai.com${articlePath}`,
      );
    } else {
      const articleResponse = await page.goto(articlePath, { waitUntil: 'domcontentloaded' });
      await expectPageAllowsIndexing(page, articleResponse);
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
        'href',
        `https://supplychainsai.com${articlePath}`,
      );
      await expect(page.locator('h1')).toHaveText(process.env.E2E_EXPECT_ARTICLE_TITLE ?? '');
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
          /^\/media\/articles\/[A-Za-z0-9:_-]+\/[a-f0-9]{64}\.(jpg|png|webp)$/,
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

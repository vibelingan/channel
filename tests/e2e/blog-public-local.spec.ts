import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const site = process.env.E2E_SITE_URL;
if (
  !site ||
  !['localhost', '127.0.0.1'].includes(new URL(site).hostname) ||
  process.env.E2E_BLOG_LOCAL_FIXTURE !== '1'
)
  throw new Error(
    'Run this fixture suite through run-blog-public-local-e2e.mjs against its owned loopback build',
  );

test('read a published article without JavaScript, including exact image bytes and SEO', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${site}/blog/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Insights');
    await page.getByRole('link', { name: 'A guide to OEM manufacturing', exact: true }).click();
    await expect(page).toHaveURL(`${site}/blog/manufacturing-guide/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'A guide to OEM manufacturing',
    );
    await expect(
      page.getByText('A useful manufacturing brief explains', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toContainText('An agreed reference sample');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${site}/blog/manufacturing-guide/`,
    );
    const image = page.getByRole('img', {
      name: 'Factory building used in this local article example',
    });
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(1228);
    const src = await image.getAttribute('src');
    expect(src).toMatch(/^\/media\/articles\/fixture-factory\/[a-f0-9]{64}\.webp$/);
    const response = await context.request.get(`${site}${src}`);
    expect(response.status()).toBe(200);
    const original = await readFile(resolve('apps/site/public/media/factory-oem.webp'));
    expect(
      createHash('sha256')
        .update(await response.body())
        .digest('hex'),
    ).toBe(createHash('sha256').update(original).digest('hex'));
    const schemas = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(schemas.join('')).toContain('2026-10-21T10:00:00.000Z');
    expect(await page.content()).not.toMatch(
      /PRIVATE-DRAFT|cloud:\/\/|pending-upload|acceptedAt|deliveryId|createdBy|tiptap|prosemirror/i,
    );
    await page.getByRole('link', { name: 'All insights', exact: true }).click();
    await expect(page).toHaveURL(`${site}/blog/`);
  } finally {
    await context.close();
  }
});

test('desktop and narrow layouts preserve the site shell, readable content and keyboard links', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${site}/blog/`);
  await expect(page.locator('[data-site-header]')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  const link = page.getByRole('link', { name: 'A guide to OEM manufacturing', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-blog-article]')).toBeVisible();
  const image = page.locator('[data-blog-article] img');
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  const headerBox = await page.locator('[data-site-header]').boundingBox();
  const breadcrumbBox = await breadcrumb.boundingBox();
  expect(headerBox && breadcrumbBox && breadcrumbBox.y >= headerBox.y + headerBox.height).toBe(
    true,
  );
  if (process.env.E2E_BLOG_PUBLIC_SCREENSHOTS === '1')
    await page.screenshot({
      path: 'output/blog-public-2026-10-23/article-desktop.png',
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.E2E_BLOG_PUBLIC_SCREENSHOTS === '1')
    await page.screenshot({
      path: 'output/blog-public-2026-10-23/article-mobile.png',
      fullPage: true,
    });
  await page.getByRole('link', { name: 'All insights', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Insights');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.E2E_BLOG_PUBLIC_SCREENSHOTS === '1')
    await page.screenshot({
      path: 'output/blog-public-2026-10-23/list-mobile.png',
      fullPage: true,
    });
});

test('drafts and unknown slugs return actual 404 and do not appear in sitemap', async ({
  request,
}) => {
  for (const path of ['/blog/private-draft-do-not-publish/', '/blog/unknown-article/']) {
    const response = await request.get(`${site}${path}`);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('PRIVATE-DRAFT-DO-NOT-PUBLISH');
  }
  const response = await request.get(`${site}/sitemap-0.xml`);
  expect(response.status()).toBe(200);
  const sitemap = await response.text();
  expect(sitemap).toContain(`${site}/blog/manufacturing-guide/`);
  expect(sitemap).not.toContain('private-draft');
});

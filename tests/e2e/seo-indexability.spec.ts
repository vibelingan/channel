import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { expectPageAllowsIndexing } from './helpers/seo-indexability.ts';

for (const example of [
  { name: 'omitted policy', head: '', headers: {}, allowed: true },
  {
    name: 'explicit index/follow',
    head: '<meta name="robots" content="index, follow">',
    headers: {},
    allowed: true,
  },
  {
    name: 'robots noindex',
    head: '<meta name="robots" content="noindex,follow">',
    headers: {},
    allowed: false,
  },
  {
    name: 'crawler-specific none',
    head: '<meta name="Googlebot" content="NONE">',
    headers: {},
    allowed: false,
  },
  {
    name: 'Bing-specific noindex',
    head: '<meta name="bingbot" content="noindex">',
    headers: {},
    allowed: false,
  },
  { name: 'HTTP restriction', head: '', headers: { 'x-robots-tag': 'noindex' }, allowed: false },
  {
    name: 'HTTP and HTML conflict',
    head: '<meta name="robots" content="index,follow">',
    headers: { 'x-robots-tag': 'googlebot: noindex' },
    allowed: false,
  },
]) {
  test(`public indexing check handles ${example.name}`, async ({ page }) => {
    await page.route('https://indexability.example.test/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: example.headers,
        body: `<!doctype html><html><head>${example.head}</head><body><h1>Product</h1></body></html>`,
      }),
    );
    const response = await page.goto('https://indexability.example.test/');
    if (example.allowed) await expectPageAllowsIndexing(page, response);
    else await assert.rejects(() => expectPageAllowsIndexing(page, response));
  });
}

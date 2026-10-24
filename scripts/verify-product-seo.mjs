import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

// Isolated local browser acceptance. Only anonymous image GETs may reach the
// public origin; product APIs and quote submission use the supplied snapshot.
const [distArg, snapshotArg, evidenceArg] = process.argv.slice(2);
if (!distArg || !snapshotArg || !evidenceArg)
  throw new Error(
    'Usage: node scripts/verify-product-seo.mjs <dist> <snapshot.json> <evidence-dir>',
  );
const root = resolve(distArg);
const evidence = resolve(evidenceArg);
const snapshot = JSON.parse(await readFile(snapshotArg, 'utf8'));
const entries = new Map(snapshot.products.map((p) => [p.product._id, p]));
await mkdir(evidence, { recursive: true });
const posts = [];
const imageCache = new Map();
let mode = 'ready';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = (value, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST') {
      if (url.pathname !== '/api/catalog-quote-requests') return json({ ok: false }, 404);
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 32000) throw new Error('Oversize local quote');
      }
      posts.push(JSON.parse(body));
      return json({ ok: true, requestId: '00000000-0000-4000-8000-000000000001' });
    }
    if (url.pathname.startsWith('/api/images/')) {
      let cached = imageCache.get(url.pathname);
      if (!cached) {
        const response = await fetch(new URL(url.pathname, snapshot.apiOrigin), {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        cached = {
          status: response.status,
          type: response.headers.get('Content-Type'),
          bytes: Buffer.from(await response.arrayBuffer()),
        };
        imageCache.set(url.pathname, cached);
      }
      res.writeHead(cached.status, { 'Content-Type': cached.type ?? 'application/octet-stream' });
      res.end(cached.bytes);
      return;
    }
    if (url.pathname === '/api/catalog-taxonomy') {
      return json({
        ok: true,
        data: {
          family: url.searchParams.get('family'),
          revision: 1,
          name: 'Local catalog categories',
          children: [],
        },
      });
    }
    if (url.pathname === '/api/products') {
      let items = [...entries.values()].map((p) => p.product);
      if (url.searchParams.has('productFamily'))
        items = items.filter((p) => p.productFamily === url.searchParams.get('productFamily'));
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 48);
      return json({
        ok: true,
        data: {
          items: items.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: items.length,
        },
      });
    }
    const detail = url.pathname.match(/^\/api\/products\/([^/]+)\/detail$/);
    const base = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (detail || base) {
      const entry = entries.get(decodeURIComponent((detail ?? base)[1]));
      if (mode === 'removed' || !entry || (detail && !entry.detail))
        return json({ ok: false, error: { code: 'NOT_FOUND' } }, 404);
      if (mode === 'unavailable') return json({ ok: false }, 503);
      return json({ ok: true, data: detail ? entry.detail : entry.product });
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false }, 404);
    let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) return json({ ok: false }, 403);
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 502);
    res.end('Not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const results = { products: [], browser: [], screenshots: [], quotesSubmittedToLocalStub: 0 };
try {
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 1000 },
  });
  await noJs.route('**/api/images/**', (route) => route.abort());
  const page = await noJs.newPage();
  for (const entry of snapshot.products) {
    const path = `/products/p-${entry.product._id}/`;
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, path);
    assert.equal(await page.locator('main h1').count(), 1, path);
    assert.equal(
      (await page.locator('main h1').textContent()).trim(),
      entry.detail?.name ?? entry.product.name,
      path,
    );
    assert.ok(await page.locator('main h1').isVisible(), path);
    assert.equal(
      await page.locator('link[rel=canonical]').getAttribute('href'),
      `${snapshot.siteOrigin}${path}`,
      path,
    );
    const text = await page.locator('main').innerText();
    const detail = entry.detail;
    const expected = detail
      ? 'content' in detail
        ? detail.content.notes[0]
        : detail.descriptionText
      : entry.product.description;
    if (expected)
      assert.ok(
        text.replace(/\s+/g, ' ').includes(expected.replace(/\s+/g, ' ')),
        `Missing initial body: ${path}`,
      );
    results.products.push({ path, status: response.status(), noJsBody: true });
  }
  await noJs.close();
  const chosen = snapshot.products.find(
    (p) => p.detail?.variants.total > 1 && !p.detail.variants.hasMore,
  );
  assert.ok(chosen, 'Acceptance needs a real multi-variant public product');
  const id = chosen.product._id;
  const path = `/products/p-${id}/`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const live = await context.newPage();
  const errors = [];
  live.on('pageerror', (e) => errors.push(e.message));
  const hydrationErrors = [];
  live.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /hydrat|did not match|Minified React error|each child.*key/i.test(message.text())
    )
      hydrationErrors.push(message.text());
  });
  // Hold refresh until after hydration, proving bootstrap survives slow APIs.
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  await live.route('**/api/products/*/detail?*', async (route) => {
    await held;
    await route.continue();
  });
  await live.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await live.waitForSelector('astro-island:not([ssr])');
  assert.equal(await live.locator('[data-shared-catalog-detail]').count(), 1);
  assert.equal(await live.locator('main > output').count(), 0);
  results.browser.push('hydrated body remains visible while refresh is held');
  release();
  // Gallery prefetch is intentionally background work, not page readiness.
  await live.waitForFunction(() => {
    const image = document.querySelector('[data-variant-gallery] img');
    return !image || (image.complete && image.naturalWidth > 0);
  });
  for (const [width, height, label] of [
    [1440, 1000, 'desktop'],
    [390, 844, 'mobile'],
  ]) {
    await live.setViewportSize({ width, height });
    await live.evaluate(() => window.scrollTo(0, 0));
    await live.screenshot({ path: resolve(evidence, `after-${label}.png`) });
    assert.ok(
      await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${label} horizontal overflow`,
    );
    results.screenshots.push(`after-${label}.png`);
  }
  await live.setViewportSize({ width: 1440, height: 1000 });
  const second = chosen.detail.variants.items[1];
  await live.locator(`input[type=radio][value="${second.id}"]`).check();
  assert.equal(new URL(live.url()).searchParams.get('variant'), second.id);
  await live.getByRole('button', { name: 'Request a quote', exact: true }).click();
  assert.ok(await live.locator('dialog[open]').isVisible());
  await live.screenshot({ path: resolve(evidence, 'quote-existing-flow.png') });
  await live.locator('input[name=quantity]').fill('1000');
  await live.locator('dialog[open] button[type=submit]').click();
  await live.locator('input[name=contactName]').fill('SEO Local Acceptance');
  await live.locator('input[name=email]').fill('seo-acceptance@example.com');
  await live.locator('input[name=company]').fill('Local fixture company');
  await live.getByRole('combobox').fill('Japan');
  await live.getByRole('option', { name: 'Japan (JP)', exact: true }).click();
  await live.locator('dialog[open] button[type=submit]').click();
  await live.locator('[data-rfq-review]').waitFor();
  await live.getByRole('button', { name: 'Send inquiry', exact: true }).click();
  await live.locator('[data-rfq-receipt]').waitFor();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].target.productId, id);
  assert.equal(posts[0].target.variantId, second.id);
  assert.equal(posts[0].target.revision, chosen.detail.revision);
  await live.keyboard.press('Escape');
  // Direct deep link restores the configuration after the identical first render.
  await live.goto(`${origin}${path}?variant=${encodeURIComponent(second.id)}`);
  await live.waitForSelector(`input[type=radio][value="${second.id}"]:checked`);
  assert.equal(
    await live.locator('link[rel=canonical]').getAttribute('href'),
    `${snapshot.siteOrigin}${path}`,
  );
  results.browser.push(
    'variant selection updates URL; refresh restores it without changing canonical; complete RFQ submits to local stub with correct product/variant/revision',
  );
  const thumbs = live.locator('[data-variant-gallery] button');
  if ((await thumbs.count()) > 1) {
    const before = await live.locator('[data-gallery-frame] img').getAttribute('src');
    await thumbs.nth(1).click();
    await live.waitForFunction(
      (previous) =>
        document.querySelector('[data-gallery-frame] img')?.getAttribute('src') !== previous,
      before,
    );
    results.browser.push('existing gallery thumbnail changes the displayed photo');
  }
  await live.goto(`${origin}/headphones/`);
  const card = live.locator(`[data-product-card="${id}"]`);
  await card.waitFor();
  const listUrl = live.url();
  assert.equal(await card.getAttribute('href'), path);
  await card.click();
  await live.locator(`[data-shared-catalog-detail="${id}"]`).waitFor();
  assert.equal(new URL(live.url()).pathname, '/headphones/');
  results.browser.push('plain card click retains category expansion and exposes canonical href');
  await live.locator('[data-shared-detail-navigation] > button').click();
  await live.locator('[data-shared-catalog-list]:not([hidden])').waitFor();
  assert.equal(live.url(), listUrl);
  results.browser.push('category Back action restores the mounted list');
  mode = 'unavailable';
  await live.goto(`${origin}${path}`);
  await live.getByRole('alert').waitFor();
  assert.equal(await live.locator('[data-shared-catalog-detail]').count(), 1);
  await live.screenshot({ path: resolve(evidence, 'temporary-api-failure.png') });
  mode = 'removed';
  await live.goto(`${origin}${path}`);
  await live.getByRole('alert').waitFor();
  assert.equal(await live.locator('[data-shared-catalog-detail]').count(), 0);
  assert.equal(await live.locator('[data-quote-open]').count(), 0);
  results.browser.push(
    'transient failure retains body; authoritative 404 removes interactive product and quote',
  );
  const legacy = snapshot.products.find((entry) => !entry.detail);
  if (legacy) {
    mode = 'unavailable';
    const legacyPath = `/products/p-${legacy.product._id}/`;
    await live.goto(`${origin}${legacyPath}`);
    await live.getByRole('alert').waitFor();
    assert.equal(await live.locator('[data-sku-detail]').count(), 1);
    assert.ok((await live.locator('main').innerText()).includes(legacy.product.description));
    mode = 'removed';
    await live.goto(`${origin}${legacyPath}`);
    await live.waitForFunction(() => !document.querySelector('[data-sku-detail]'));
    results.browser.push(
      'legacy no-slug page retains body and retry on outage, removes body on confirmed withdrawal',
    );
  }
  assert.equal((await live.goto(`${origin}/products/p-unknown-product/`)).status(), 404);
  assert.deepEqual(errors, []);
  assert.deepEqual(hydrationErrors, []);
  results.quotesSubmittedToLocalStub = posts.length;
  results.browser.push('unknown standard route returns HTTP 404; no pageerror');
  await context.close();
} finally {
  await writeFile(resolve(evidence, 'verification.json'), JSON.stringify(results, null, 2));
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
console.log(
  `Verified ${results.products.length} product pages without JS; ${results.browser.length} browser acceptance checks.`,
);

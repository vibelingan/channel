import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatalogTaxonomySchema, initialCatalogTaxonomy } from '@vibelingan-channel/shared';
import { parseDocument } from 'yaml';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { createCatalogPreparationAuthority } from '../../../../../packages/db/src/catalog-preparation-authority.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { rows } from '../../../../../packages/db/src/testing/catalog-readiness-fixtures.ts';
import { setMediaStorage } from '../../../../../packages/media-storage/src/index.ts';
import { LocalDiskMediaStorage } from '../../../../../packages/media-storage/src/local-disk.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { runCatalogPreparationCall } from '../../../../functions/alibaba-catalog-sync/src/catalog-preparation.ts';
import { createLocalCatalogPreparationInvoker } from '../../../../local-server/src/catalog-preparation-invoker.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  width = 1440,
  options: {
    summarizeList?: boolean;
    ignoreProductAbort?: boolean;
    products?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'channel-list-readiness-'));
  let closeBrowser = async () => {};
  let closeServer = async () => {};
  t.after(async () => {
    await closeBrowser();
    await closeServer();
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'db.json');
  const products = rows().map((row) => ({
    ...row,
    updatedAt: '2026-10-17T00:00:00.000Z',
    ...(['ready', 'blocked'].includes(String(row._id)) ? { subcategoryIds: ['clock'] } : {}),
    ...options.products?.[String(row._id)],
  }));
  const taxonomy = CatalogTaxonomySchema.parse({
    ...initialCatalogTaxonomy('misc'),
    children: [
      { id: 'clock', name: 'Clocks', slug: 'clocks', order: 0, status: 'active' },
      { id: 'other', name: 'Other', slug: 'other', order: 1, status: 'active' },
    ],
  });
  const initialBytes = JSON.stringify({
    users: [{ _id: 'admin', role: 'admin' }],
    products,
    catalogTaxonomies: [{ _id: 'misc', ...taxonomy }],
  });
  await writeFile(file, initialBytes);
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  setMediaStorage(new LocalDiskMediaStorage(join(directory, 'media')));
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-list-readiness',
    environmentId: 'owned-list-browser',
  });
  const config = {
    jwtSecret: 'owned-list-readiness',
    enableDetailApproval: true,
    preparationAuthority: authority,
    preparationInvoke: createLocalCatalogPreparationInvoker((call) =>
      runCatalogPreparationCall(authority, call),
    ),
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
  });
  const { chromium, expect } = await import('@playwright/test');
  const { createServer } = await import('vite');
  const { default: tailwind } = await import('@tailwindcss/vite');
  const server = await createServer({
    configFile: false,
    cacheDir: join(directory, 'vite'),
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    optimizeDeps: {
      noDiscovery: false,
      entries: ['src/islands/admin/testing/catalog-list-readiness-browser-harness.tsx'],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zod',
      ],
    },
    plugins: [
      {
        name: 'list-real-i18n-frontmatter',
        enforce: 'pre',
        transform(source, id) {
          if (!id.endsWith('.md') || !id.includes('/src/i18n/content/')) return;
          const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
          if (!match?.[1]) throw Error('Missing actual frontmatter');
          const doc = parseDocument(match[1], { uniqueKeys: true });
          if (doc.errors.length) throw Error('Invalid actual frontmatter');
          return { code: `export const frontmatter=${JSON.stringify(doc.toJSON())};`, map: null };
        },
      },
      tailwind(),
      {
        name: 'list-test-page',
        configureServer(server) {
          server.middlewares.use('/catalog-list-test', (_req, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(
              '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="catalog-list-root"></div></body></html>',
            );
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  });
  closeServer = () => server.close();
  await server.listen();
  const origin = server.resolvedUrls?.local[0];
  assert.ok(origin);
  const browser = await chromium.launch({ headless: true });
  closeBrowser = () => browser.close();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests: { action: string; data?: Record<string, unknown> }[] = [];
  const controls = {
    failList: 0,
    failCount: 0,
    invalidList: 0,
    failGet: 0,
    wrongGet: 0,
    summaryGet: 0,
    invalidView: 0,
    holdGetId: null as string | null,
    releaseGet: null as (() => Promise<void>) | null,
    holdListScope: null as string | null,
    holdCountScope: null as string | null,
    releaseList: null as (() => Promise<void>) | null,
    releaseCount: null as (() => Promise<void>) | null,
  };
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postData();
    assert.ok(body);
    const parsed = JSON.parse(body);
    assert.equal(parsed.token, token);
    requests.push({ action: parsed.action, data: parsed.data });
    const list = parsed.action === 'list' && parsed.data?.collection === 'products';
    const count = list && parsed.data.pageSize === 1;
    const productGet = parsed.action === 'get' && parsed.data?.collection === 'products';
    if (productGet && controls.failGet > 0) {
      controls.failGet--;
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: { code: 'UNAVAILABLE', message: 'Owned temporary product read failure' },
        },
      });
      return;
    }
    if (list && ((count && controls.failCount > 0) || (!count && controls.failList > 0))) {
      if (count) controls.failCount--;
      else controls.failList--;
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: { code: 'UNAVAILABLE', message: 'Owned temporary list read failure' },
        },
      });
      return;
    }
    const response = await handleAdminFunctionEvent(
      { httpMethod: 'POST', body },
      config,
      handleAdminRequest,
    );
    assert.ok('statusCode' in response);
    let responseBody = response.body;
    if (list && options.summarizeList) {
      const wire = JSON.parse(responseBody);
      assert.equal(wire.ok, true);
      wire.data.items = wire.data.items.map((row: Record<string, unknown>) => {
        const {
          description: _description,
          series: _series,
          modName: _model,
          imageIds: _images,
          manualCatalogPricing: _manual,
          ...summary
        } = row;
        return summary;
      });
      responseBody = JSON.stringify(wire);
    }
    if (list && !count && controls.invalidView > 0) {
      controls.invalidView--;
      const wire = JSON.parse(responseBody);
      assert.equal(wire.ok, true);
      Reflect.deleteProperty(wire.data, 'catalogListView');
      responseBody = JSON.stringify(wire);
    }
    if (productGet && controls.summaryGet > 0) {
      controls.summaryGet--;
      const wire = JSON.parse(responseBody);
      assert.equal(wire.ok, true);
      wire.data._adminProductListView = 'admin-product-list-v1';
      responseBody = JSON.stringify(wire);
    }
    if (productGet && controls.wrongGet > 0) {
      controls.wrongGet--;
      const wire = JSON.parse(responseBody);
      assert.equal(wire.ok, true);
      wire.data._id = 'wrong-record';
      responseBody = JSON.stringify(wire);
    }
    const fulfill = () =>
      route.fulfill({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody,
      });
    if (productGet && controls.holdGetId === parsed.data.id) {
      controls.releaseGet = fulfill;
      return;
    }
    if (list && !count && controls.invalidList > 0) {
      controls.invalidList--;
      const wire = JSON.parse(response.body);
      assert.equal(wire.ok, true);
      wire.data.total = 'invalid';
      await route.fulfill({ status: 200, json: wire });
      return;
    }
    if (list && !count && controls.holdListScope === parsed.data.catalogReadiness) {
      controls.holdListScope = null;
      controls.releaseList = fulfill;
      return;
    }
    if (count && controls.holdCountScope === parsed.data.catalogReadiness) {
      controls.holdCountScope = null;
      controls.releaseCount = fulfill;
      return;
    }
    await fulfill();
  });
  if (options.ignoreProductAbort) {
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const completed: Record<string, number> = {};
      Reflect.set(window, 'ownedProductReadCompletions', completed);
      window.fetch = async (input, init) => {
        if (typeof init?.body !== 'string') return originalFetch(input, init);
        const body = JSON.parse(init.body);
        if (body.action !== 'get' || body.data?.collection !== 'products')
          return originalFetch(input, init);
        // This negative transport ignores abort but preserves real response bytes.
        const { signal: _signal, ...request } = init;
        const response = await originalFetch(input, request);
        const bytes = await response.arrayBuffer();
        setTimeout(() => {
          completed[body.data.id] = (completed[body.data.id] ?? 0) + 1;
        }, 0);
        return new Response(bytes, { status: response.status, headers: response.headers });
      };
    });
  }
  await page.goto(`${origin}catalog-list-test`);
  await page.evaluate(
    async ({ token, harness }) => {
      const module = await import(harness);
      module.renderList(token);
    },
    { token, harness: '/src/islands/admin/testing/catalog-list-readiness-browser-harness.tsx' },
  );
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Clock ready', exact: true })).toBeVisible();
  const settled = async (scope: string, kind: 'main' | 'count' = 'main') =>
    page.evaluate(
      async ({ scope, kind, harness }) => {
        const module = await import(harness);
        return module.hasSettled(scope, kind);
      },
      {
        scope,
        kind,
        harness: '/src/islands/admin/testing/catalog-list-readiness-browser-harness.tsx',
      },
    );
  await expect.poll(() => settled('all', 'count')).toBe(true);
  return { page, expect, file, adapter, requests, errors, controls, initialBytes, settled };
}

test(
  'existing Products table remains readable after readiness controls are added',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const directory = fileURLToPath(
      new URL('../../../../../output/pricing-clock-repair-2026-10-13/p2g3/', import.meta.url),
    );
    await mkdir(directory, { recursive: true });
    await f.page.screenshot({ path: join(directory, 'list-current-desktop.png'), fullPage: true });
    assert.deepEqual(f.errors, []);
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
  },
);

test(
  'Check status composes the actual backend scope and clears old selections',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    await f.page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
    await f.expect(f.page.getByText('20 selected', { exact: true })).toBeVisible();
    const select = f.page.getByRole('combobox', { name: 'Check status', exact: true });
    await f.expect(select).toBeVisible({ timeout: 5000 });
    await select.click();
    await f.page
      .getByRole('listbox', { name: 'Check status', exact: true })
      .getByRole('option', { name: 'Ready or published', exact: true })
      .click();
    await f.expect
      .poll(
        () =>
          f.requests.filter((r) => r.action === 'list' && r.data?.pageSize !== 1).at(-1)?.data
            ?.catalogReadiness,
      )
      .toBe('normal');
    await f.expect(f.page.getByRole('cell', { name: 'Clock blocked', exact: true })).toHaveCount(0);
    await f.expect(f.page.getByText(/^\d+ selected$/)).toHaveCount(0);
    await f.expect(f.page.getByText('4 records', { exact: true })).toBeVisible();
    await f
      .expect(f.page.getByRole('checkbox', { name: 'Select row', exact: true }))
      .toHaveCount(4);
    for (const checkbox of await f.page
      .getByRole('checkbox', { name: 'Select row', exact: true })
      .all())
      await f.expect(checkbox).not.toBeChecked();
    await scope(f, 'All check statuses');
    await f.expect(f.page.getByText('23 records', { exact: true })).toBeVisible();
    await f.expect(f.page.getByText(/^\d+ selected$/)).toHaveCount(0);
    for (const checkbox of await f.page
      .getByRole('checkbox', { name: 'Select row', exact: true })
      .all())
      await f.expect(checkbox).not.toBeChecked();
    assert.deepEqual(f.errors, []);
  },
);

async function scope(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  await f.page.getByRole('combobox', { name: 'Check status', exact: true }).click();
  await f.page
    .getByRole('listbox', { name: 'Check status', exact: true })
    .getByRole('option', { name: label, exact: true })
    .click();
}
function productRow(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  return f.page
    .locator('tbody tr')
    .filter({ has: f.page.getByRole('cell', { name, exact: true }) });
}

test(
  'failed or malformed list and count reads have usable retries and no false zero',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    await f.page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
    f.controls.failList = 1;
    await productRow(f, 'Clock ready')
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    await f.expect(f.page.getByRole('dialog')).toBeVisible();
    await f.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await f.expect(f.page.getByRole('button', { name: 'Retry list', exact: true })).toBeVisible();
    await f.expect(f.page.getByText('Record count unavailable', { exact: true })).toBeVisible();
    await f.expect(f.page.getByText('No records.', { exact: true })).toHaveCount(0);
    await f
      .expect(f.page.getByRole('spinbutton', { name: 'Go to page', exact: true }))
      .toHaveCount(0);
    await f.expect(f.page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await f.page.getByRole('button', { name: 'Retry list', exact: true }).click();
    await f.expect(f.page.getByText('23 records', { exact: true })).toBeVisible();
    await f.expect(f.page.getByText('20 selected', { exact: true })).toBeVisible();
    f.controls.invalidList = 1;
    await scope(f, 'Data issues');
    await f.expect(f.page.getByRole('button', { name: 'Retry list', exact: true })).toBeVisible();
    await f.expect(f.page.getByText('0 records', { exact: true })).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Retry list', exact: true }).click();
    await f.expect(f.page.getByText('2 records', { exact: true })).toBeVisible();
    f.controls.failCount = 1;
    await scope(f, 'Unchecked');
    await f
      .expect(f.page.getByText('Classification count unavailable.', { exact: false }))
      .toBeVisible();
    await f
      .expect(f.page.getByRole('button', { name: 'Needs classification', exact: true }))
      .toBeVisible();
    await f.page.getByRole('button', { name: 'Retry count', exact: true }).click();
    await f
      .expect(f.page.getByRole('button', { name: 'Needs classification (2)', exact: true }))
      .toBeVisible();
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'late list and classification-count responses cannot overwrite new scope or selection',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    f.controls.holdListScope = 'issues';
    await scope(f, 'Data issues');
    await f.expect.poll(() => Boolean(f.controls.releaseList)).toBe(true);
    await scope(f, 'Ready or published');
    await f.expect(f.page.getByText('4 records', { exact: true })).toBeVisible();
    await productRow(f, 'Clock ready')
      .getByRole('checkbox', { name: 'Select row', exact: true })
      .check();
    const release = f.controls.releaseList;
    assert.ok(release);
    await release();
    await f.expect.poll(() => f.settled('issues')).toBe(true);
    await f.expect(f.page.getByText('4 records', { exact: true })).toBeVisible();
    await f.expect(f.page.getByText('1 selected', { exact: true })).toBeVisible();
    await f.expect(f.page.getByRole('cell', { name: 'Clock blocked', exact: true })).toHaveCount(0);
    f.controls.holdCountScope = 'preparing';
    await scope(f, 'Preparing');
    await f.expect.poll(() => Boolean(f.controls.releaseCount)).toBe(true);
    await scope(f, 'Unchecked');
    await f
      .expect(f.page.getByRole('button', { name: 'Needs classification (2)', exact: true }))
      .toBeVisible();
    const count = f.controls.releaseCount;
    assert.ok(count);
    await count();
    await f.expect.poll(() => f.settled('preparing', 'count')).toBe(true);
    await f
      .expect(f.page.getByRole('button', { name: 'Needs classification (2)', exact: true }))
      .toBeVisible();
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'mobile scoped list stays inside the viewport and supports real pagination',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 390);
    const geometry = await f.page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert.ok(geometry.page <= geometry.viewport, JSON.stringify(geometry));
    await f.page.getByRole('button', { name: 'Next', exact: true }).click();
    await f.expect(f.page.getByText('2 / 2', { exact: true })).toBeVisible();
    await scope(f, 'Ready or published');
    await f.expect(f.page.getByText('1 / 1', { exact: true })).toBeVisible();
    assert.match(f.page.url(), /checkStatus=normal/);
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'mobile publication menu respects the same problem-scope block as desktop',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 390);
    await scope(f, 'Data issues');
    await productRow(f, 'Clock blocked')
      .getByRole('checkbox', { name: 'Select row', exact: true })
      .check();
    await f.page
      .locator('summary')
      .filter({ hasText: /^Actions$/ })
      .click();
    await f.expect(f.page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    const openedGeometry = await f.page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert.ok(openedGeometry.page <= openedGeometry.viewport, JSON.stringify(openedGeometry));
    const openedButton = await f.page
      .getByRole('button', { name: 'Publish', exact: true })
      .boundingBox();
    assert.ok(
      openedButton &&
        openedButton.x >= 0 &&
        openedButton.x + openedButton.width <= openedGeometry.viewport,
      JSON.stringify(openedButton),
    );
    const screenshotDirectory = fileURLToPath(
      new URL('../../../../../output/pricing-clock-repair-2026-10-13/p2g3/', import.meta.url),
    );
    await mkdir(screenshotDirectory, { recursive: true });
    await f.page.screenshot({
      path: join(screenshotDirectory, 'list-current-mobile-issues.png'),
      fullPage: true,
    });
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

async function pick(f: Awaited<ReturnType<typeof fixture>>, label: string, value: string | RegExp) {
  await f.page
    .getByRole('combobox', { name: label, exact: true })
    .and(f.page.locator('button'))
    .click();
  await f.page
    .getByRole('listbox', { name: label, exact: true })
    .getByRole('option', { name: value, exact: typeof value === 'string' })
    .click();
}

test(
  'scope, family, subcategory, search and OR filters compose through the real UI and history',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    await scope(f, 'Ready or published');
    await f.page
      .getByRole('group', { name: 'Product family', exact: true })
      .getByRole('button', { name: 'Misc', exact: true })
      .click();
    await f.expect(f.page.getByText('3 records', { exact: true })).toBeVisible();
    await pick(f, 'Website subcategory', 'Clocks');
    await f.expect(f.page.getByText('1 record', { exact: true })).toBeVisible();
    const search = f.page.getByRole('textbox', { name: /^Search name/ });
    await search.fill('not-a-product');
    await f.page.getByRole('button', { name: 'Search', exact: true }).click();
    await f.expect(f.page.getByText('No records.', { exact: true })).toBeVisible();
    await f.expect(f.page.getByText('0 records', { exact: true })).toBeVisible();
    await search.fill('');
    await f.page.getByRole('button', { name: 'Search', exact: true }).click();
    await f.expect(f.page.getByText('1 record', { exact: true })).toBeVisible();
    await f.page.getByRole('button', { name: 'Filters', exact: true }).click();
    await pick(f, 'Filter 1 field', 'Name');
    await pick(f, 'Filter 1 operator', /contains/i);
    await f.page.getByPlaceholder('Value', { exact: true }).first().fill('ready');
    await f.page.getByRole('button', { name: '+ Add condition', exact: true }).click();
    await pick(f, 'Filter 2 field', 'Name');
    await pick(f, 'Filter 2 operator', /contains/i);
    await f.page.getByPlaceholder('Value', { exact: true }).nth(1).fill('blocked');
    await f.page.getByRole('button', { name: 'Match any (OR)', exact: true }).click();
    await f.page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await f.expect(f.page.getByRole('cell', { name: 'Clock ready', exact: true })).toBeVisible();
    await f.expect(f.page.getByRole('cell', { name: 'Clock blocked', exact: true })).toHaveCount(0);
    await f.expect
      .poll(() =>
        f.requests.some(
          (r) =>
            r.action === 'list' &&
            r.data?.pageSize !== 1 &&
            r.data?.catalogReadiness === 'normal' &&
            r.data?.filter !== undefined,
        ),
      )
      .toBe(true);
    const request = f.requests
      .filter((r) => r.action === 'list' && r.data?.pageSize !== 1)
      .at(-1)?.data;
    assert.ok(request);
    assert.equal(request.catalogReadiness, 'normal');
    assert.equal(request.productFamily, 'misc');
    assert.deepEqual(request.subcategoryIds, ['clock']);
    assert.deepEqual(request.filter, {
      combinator: 'or',
      clauses: [
        { field: 'name', op: 'contains', value: 'ready' },
        { field: 'name', op: 'contains', value: 'blocked' },
      ],
    });
    await f.page.goBack();
    await f.expect(f.page.getByText('3 records', { exact: true })).toBeVisible();
    assert.doesNotMatch(f.page.url(), /subcategory=/);
    await f.page.goForward();
    await f.expect(f.page.getByText('1 record', { exact: true })).toBeVisible();
    assert.match(f.page.url(), /subcategory=clock/);
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

for (const width of [1440, 390])
  test(
    `problem-scope classification can save without publishing at ${width}px`,
    { timeout: 90000 },
    async (t) => {
      const f = await fixture(t, width);
      await scope(f, 'Data issues');
      const row = productRow(f, 'Clock blocked');
      await f.expect(row.getByRole('button', { name: 'Disabled', exact: true })).toBeDisabled();
      await row.getByRole('checkbox', { name: 'Select row', exact: true }).check();
      await f.page.getByRole('button', { name: 'Assign category', exact: true }).click();
      const dialog = f.page.getByRole('dialog', {
        name: 'Edit website classification',
        exact: true,
      });
      await f.expect(dialog).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Other', exact: true }).check();
      await f
        .expect(dialog.getByRole('button', { name: 'Save and publish', exact: true }))
        .toBeDisabled();
      await f
        .expect(dialog.getByRole('button', { name: 'Save classification', exact: true }))
        .toBeEnabled();
      await dialog.getByRole('button', { name: 'Save classification', exact: true }).click();
      await dialog.getByRole('button', { name: 'Confirm save', exact: true }).click();
      await f.expect(dialog).toHaveCount(0);
      const saved = await f.adapter.get('products', 'blocked');
      const before = rows().find((row) => row._id === 'blocked');
      assert.ok(saved && before);
      assert.equal(saved.published, false);
      assert.equal(saved.productFamily, 'misc');
      assert.deepEqual(saved.subcategoryIds, ['clock', 'other']);
      assert.equal(saved.catalogContentGeneration, 2);
      assert.equal(saved.catalogPreparationState, 'blocked');
      assert.deepEqual(saved.catalogPreparationReport, before.catalogPreparationReport);
      assert.equal(
        f.requests.filter(
          (r) => r.action === 'catalogCategories' && r.data?.operation === 'replace',
        ).length,
        1,
      );
      assert.equal(
        f.requests.filter(
          (r) =>
            r.action === 'batchUpdate' ||
            r.action === 'catalogDetailApproval' ||
            r.action === 'catalogPreparation',
        ).length,
        0,
      );
      const stored = JSON.parse(await readFile(f.file, 'utf8'));
      assert.deepEqual(stored.catalogDetailApprovals ?? [], []);
      assert.deepEqual(stored.catalogDetailVariants ?? [], []);
      assert.deepEqual(f.errors, []);
    },
  );

test(
  'real list Edit repair then Preview preparation refreshes the scope without publication',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    await scope(f, 'Data issues');
    await productRow(f, 'Clock blocked').getByRole('button', { name: 'Edit', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form).toBeVisible();
    await form.locator('#name').fill('Repaired browser clock');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    await f.expect(f.page.getByText('1 record', { exact: true })).toBeVisible();
    await scope(f, 'Unchecked');
    await productRow(f, 'Repaired browser clock')
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    const preview = f.page.getByRole('dialog');
    await f.expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Prepare saved product', exact: true }).click();
    await f
      .expect(
        preview.getByText(
          'Saved product content is ready. Publishing still checks category and permissions.',
          { exact: true },
        ),
      )
      .toBeVisible();
    await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
    await f
      .expect(f.page.getByRole('cell', { name: 'Repaired browser clock', exact: true }))
      .toHaveCount(0);
    await scope(f, 'Ready or published');
    await f
      .expect(f.page.getByRole('cell', { name: 'Repaired browser clock', exact: true }))
      .toBeVisible();
    const saved = await f.adapter.get('products', 'blocked');
    assert.equal(saved?.published, false);
    assert.equal(saved?.productFamily, 'misc');
    assert.deepEqual(saved?.subcategoryIds, ['clock']);
    assert.equal(saved?.catalogPreparationState, 'ready');
    assert.equal(f.requests.filter((r) => r.action === 'update').length, 1);
    assert.equal(
      f.requests.filter((r) => r.action === 'catalogCategories' && r.data?.operation === 'replace')
        .length,
      0,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  'a legacy unclassified item can be prepared from its list without creating a publication or category',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    await scope(f, 'Unchecked');
    await productRow(f, 'Clock legacy')
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    const preview = f.page.getByRole('dialog');
    await preview.getByRole('button', { name: 'Prepare saved product', exact: true }).click();
    await f
      .expect(
        preview.getByText(
          'Saved product content is ready. Publishing still checks category and permissions.',
          { exact: true },
        ),
      )
      .toBeVisible();
    await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
    await f.expect(f.page.getByRole('cell', { name: 'Clock legacy', exact: true })).toHaveCount(0);
    await scope(f, 'Ready or published');
    await f.expect(f.page.getByRole('cell', { name: 'Clock legacy', exact: true })).toBeVisible();
    const saved = await f.adapter.get('products', 'legacy');
    assert.ok(saved);
    for (const field of ['published', 'productFamily', 'category', 'subcategoryIds'])
      assert.equal(Object.hasOwn(saved, field), false, field);
    assert.equal(saved.catalogPreparationState, 'ready');
    assert.equal(
      f.requests.filter(
        (r) =>
          r.action === 'update' ||
          r.action === 'batchUpdate' ||
          (r.action === 'catalogCategories' && r.data?.operation === 'replace'),
      ).length,
      0,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  '375px Actions menu fits the page with twenty selected products',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 375);
    await f.page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
    await f.expect(f.page.getByText('20 selected', { exact: true })).toBeVisible();
    await f.page
      .locator('summary')
      .filter({ hasText: /^Actions$/ })
      .click();
    await f.expect(f.page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    const geometry = await f.page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    assert.ok(geometry.page <= geometry.viewport, JSON.stringify(geometry));
    const menu = await f.page.getByRole('button', { name: 'Publish', exact: true }).boundingBox();
    assert.ok(
      menu && menu.x >= 0 && menu.x + menu.width <= geometry.viewport,
      JSON.stringify(menu),
    );
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'a list summary never seeds or overwrites omitted saved fields in Edit',
  { timeout: 90000 },
  async (t) => {
    const full = {
      description: 'Full saved description, absent from a list row.',
      series: 'Saved series',
      modName: 'Complete model',
    };
    const f = await fixture(t, 1440, { summarizeList: true, products: { blocked: full } });
    await productRow(f, 'Clock blocked').getByRole('button', { name: 'Edit', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form.locator('#description')).toHaveValue(full.description);
    await f.expect(form.locator('#series')).toHaveValue(full.series);
    await f.expect(form.locator('#modName')).toHaveValue(full.modName);
    await form.locator('#name').fill('Safe summary edit');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    const saved = await f.adapter.get('products', 'blocked');
    assert.ok(saved);
    for (const [field, value] of Object.entries(full)) assert.equal(saved[field], value, field);
    assert.equal(saved.name, 'Safe summary edit');
    assert.equal(saved.published, false);
    assert.deepEqual(saved.subcategoryIds, ['clock']);
    assert.ok(f.requests.some((r) => r.action === 'get' && r.data?.id === 'blocked'));
    assert.equal(f.requests.filter((r) => r.action === 'update').length, 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'opening Edit uses the current saved version after its list row becomes stale',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 1440, { summarizeList: true });
    await f.adapter.update('products', 'blocked', {
      description: 'New saved version',
      series: 'New series',
    });
    await productRow(f, 'Clock blocked').getByRole('button', { name: 'Edit', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form.locator('#description')).toHaveValue('New saved version');
    await form.locator('#name').fill('Current version edit');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    const saved = await f.adapter.get('products', 'blocked');
    assert.equal(saved?.description, 'New saved version');
    assert.equal(saved?.series, 'New series');
    assert.equal(saved?.name, 'Current version edit');
    assert.equal(saved?.published, false);
    assert.deepEqual(f.errors, []);
  },
);

for (const mode of ['Edit', 'Preview'] as const)
  for (const failure of ['failGet', 'wrongGet'] as const)
    test(
      `full product read ${failure} has a read-only retry before ${mode} can open`,
      { timeout: 90000 },
      async (t) => {
        const f = await fixture(t, 1440, {
          summarizeList: true,
          products: { blocked: { description: 'Read-only retry content' } },
        });
        f.controls[failure] = 100;
        await productRow(f, 'Clock blocked')
          .getByRole('button', { name: mode, exact: true })
          .click();
        const loading = f.page.getByRole('dialog', { name: 'Load product', exact: true });
        const target = f.page.getByRole('dialog', {
          name: mode === 'Edit' ? 'Edit Product' : 'Product preview',
          exact: true,
        });
        await f
          .expect(loading.getByRole('button', { name: 'Retry load', exact: true }))
          .toBeVisible();
        await f.expect(target).toHaveCount(0);
        if (mode === 'Edit' && failure === 'wrongGet') {
          await f.page.setViewportSize({ width: 390, height: 900 });
          const geometry = await f.page.evaluate(() => ({
            page: document.documentElement.scrollWidth,
            viewport: innerWidth,
          }));
          assert.ok(geometry.page <= geometry.viewport, JSON.stringify(geometry));
          const directory = fileURLToPath(
            new URL(
              '../../../../../output/pricing-clock-repair-2026-10-13/p2g4a/',
              import.meta.url,
            ),
          );
          await mkdir(directory, { recursive: true });
          await f.page.screenshot({
            path: join(directory, 'product-read-mobile-error.png'),
            fullPage: true,
          });
        }
        assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
        f.controls[failure] = 0;
        await loading.getByRole('button', { name: 'Retry load', exact: true }).click();
        await f.expect(target).toBeVisible();
        if (mode === 'Edit') {
          await f.expect(target.locator('#description')).toHaveValue('Read-only retry content');
          await target.getByRole('button', { name: 'Cancel', exact: true }).click();
        } else {
          await target.getByRole('button', { name: 'Close', exact: true }).first().click();
        }
        await f.expect(target).toHaveCount(0);
        assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
        assert.deepEqual(f.errors, []);
      },
    );

test(
  'closing a slow product open cannot replace another form or a reopened product',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 1440, { summarizeList: true, ignoreProductAbort: true });
    f.controls.holdGetId = 'blocked';
    await productRow(f, 'Clock blocked').getByRole('button', { name: 'Edit', exact: true }).click();
    await f.expect.poll(() => Boolean(f.controls.releaseGet)).toBe(true);
    f.controls.holdGetId = null;
    await f.page
      .getByRole('dialog', { name: 'Load product', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await productRow(f, 'Clock ready').getByRole('button', { name: 'Edit', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form.locator('#name')).toHaveValue('Clock ready');
    await form.locator('#name').fill('Unsaved user input');
    const release = f.controls.releaseGet;
    assert.ok(release);
    await release();
    await f.expect
      .poll(() =>
        f.page.evaluate(() => Reflect.get(window, 'ownedProductReadCompletions')?.blocked ?? 0),
      )
      .toBeGreaterThan(0);
    await f.expect(form.locator('#name')).toHaveValue('Unsaved user input');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    assert.equal(f.requests.filter((r) => r.action === 'update').at(-1)?.data?.id, 'ready');
    const savedReady = await f.adapter.get('products', 'ready');
    assert.equal(savedReady?.name, 'Unsaved user input');
    assert.equal(savedReady?.published, false);
    assert.deepEqual(savedReady?.subcategoryIds, ['clock']);
    await productRow(f, 'Clock blocked').getByRole('button', { name: 'Edit', exact: true }).click();
    await f.expect(form.locator('#name')).toHaveValue('Clock blocked');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    const stored = JSON.parse(await readFile(f.file, 'utf8'));
    assert.deepEqual(
      stored.products.filter((row: { _id: string }) => row._id !== 'ready'),
      JSON.parse(f.initialBytes).products.filter((row: { _id: string }) => row._id !== 'ready'),
    );
    assert.equal(f.requests.filter((r) => r.action === 'update').length, 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  'a flagged row Publish waits for the full Edit record and never publishes implicitly',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 1440, {
      summarizeList: true,
      products: {
        blocked: {
          alibabaReviewPending: true,
          alibabaReviewReason: 'changed',
          description: 'Full flagged content',
        },
      },
    });
    f.controls.failGet = 100;
    await productRow(f, 'Clock blocked')
      .getByRole('button', { name: 'Disabled', exact: true })
      .click();
    const loading = f.page.getByRole('dialog', { name: 'Load product', exact: true });
    await f.expect(loading.getByRole('button', { name: 'Retry load', exact: true })).toBeVisible();
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    f.controls.failGet = 0;
    await loading.getByRole('button', { name: 'Retry load', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form.locator('#description')).toHaveValue('Full flagged content');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.equal(
      f.requests.filter((r) =>
        ['update', 'batchUpdate', 'catalogDetailApproval'].includes(r.action),
      ).length,
      0,
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  'Preview Review changes re-reads the full record before opening Edit',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, 1440, {
      summarizeList: true,
      products: {
        blocked: {
          published: true,
          alibabaReviewPending: true,
          alibabaReviewReason: 'changed',
          description: 'Full review content',
        },
      },
    });
    await productRow(f, 'Clock blocked')
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    const preview = f.page.getByRole('dialog', { name: 'Product preview', exact: true });
    await f.expect(preview).toBeVisible();
    f.controls.wrongGet = 100;
    await preview.getByRole('button', { name: 'Review changes', exact: true }).click();
    const loading = f.page.getByRole('dialog', { name: 'Load product', exact: true });
    await f.expect(loading.getByRole('button', { name: 'Retry load', exact: true })).toBeVisible();
    await f.expect(preview).toHaveCount(0);
    await f
      .expect(f.page.getByRole('dialog', { name: 'Edit Product', exact: true }))
      .toHaveCount(0);
    f.controls.wrongGet = 0;
    await loading.getByRole('button', { name: 'Retry load', exact: true }).click();
    const form = f.page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await f.expect(form.locator('#description')).toHaveValue('Full review content');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await f.expect(form).toHaveCount(0);
    assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
    assert.equal(
      f.requests.filter((r) =>
        ['update', 'batchUpdate', 'catalogDetailApproval'].includes(r.action),
      ).length,
      0,
    );
    assert.deepEqual(f.errors, []);
  },
);

test('actual collection main and classification count opt into the product summary protocol', async (t) => {
  const f = await fixture(t);
  await f.settled('all');
  await f.settled('all', 'count');
  const lists = f.requests.filter((r) => r.action === 'list' && r.data?.collection === 'products');
  assert.ok(lists.some((r) => r.data?.pageSize === 1));
  assert.ok(lists.some((r) => r.data?.pageSize === 20));
  for (const request of lists) assert.equal(request.data?.catalogListView, 'admin-product-list-v1');
});

test('summary returned from complete GET has a usable retry and never opens a writable form', async (t) => {
  const f = await fixture(t);
  f.controls.summaryGet = 100;
  const row = f.page
    .getByRole('row')
    .filter({ has: f.page.getByRole('cell', { name: 'Clock ready', exact: true }) });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const loader = f.page.getByRole('dialog', { name: 'Load product' });
  await f.expect(loader.getByRole('button', { name: 'Retry load' })).toBeVisible();
  await f.expect(f.page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  f.controls.summaryGet = 0;
  await loader.getByRole('button', { name: 'Retry load' }).click();
  await f.expect(f.page.getByRole('dialog', { name: 'Edit Product' })).toBeVisible();
  await f.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await readFile(f.file, 'utf8'), f.initialBytes);
  assert.equal(
    f.requests.some((r) => ['update', 'batchUpdate', 'catalogDetailApproval'].includes(r.action)),
    false,
  );
  assert.deepEqual(f.errors, []);
});

test('unconfirmed summary version leaves a readable retry instead of an empty or writable list', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');
  f.controls.invalidView = 1;
  await scope(f, 'Data issues');
  await f.expect(f.page.getByRole('button', { name: 'Retry list', exact: true })).toBeVisible();
  await f.expect(f.page.getByText('0 records', { exact: true })).toHaveCount(0);
  await f.expect(f.page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await f.page.getByRole('button', { name: 'Retry list', exact: true }).click();
  await f.expect(f.page.getByText('2 records', { exact: true })).toBeVisible();
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.deepEqual(f.errors, []);
});

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import { signSession } from '../../../../../../packages/auth/src/jwt.ts';
import { createCatalogPreparationAuthority } from '../../../../../../packages/db/src/catalog-preparation-authority.ts';
import { readCurrentCatalogPreparation } from '../../../../../../packages/shared/src/catalog/preparation.ts';
import { encryptTokenPayload } from '../../../../../functions/alibaba-catalog-sync/src/crypto.ts';
import {
  handleAlibabaSyncRequest,
  resolveRuntime,
} from '../../../../../functions/alibaba-catalog-sync/src/handler.ts';
import { importCandidateImage } from '../../../../../functions/alibaba-catalog-sync/src/media-import.ts';
import { getConnectionAccessToken } from '../../../../../functions/alibaba-catalog-sync/src/oauth.ts';
import { prepareAlibabaPhotosPage } from '../../../../../functions/alibaba-catalog-sync/src/photo-preparation.ts';
import { prepareSyncedCatalogSource } from '../../../../../functions/alibaba-catalog-sync/src/sync-readiness.ts';
import { resumeSyncWorkflow } from '../../../../../functions/alibaba-catalog-sync/src/sync-workflow.ts';
import {
  coldOwnedMedia,
  ownedColdPng,
  workspace,
} from '../../../../../local-server/src/testing/catalog-operation-workspace.ts';
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const site = join(root, 'apps/site');
const origin = 'https://supplychainsai.com';
const api = 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com';
test(
  'normal one-click UI survives page closure; real source runner, raw storage, photo import, and restored UI finish without browser continuation',
  { timeout: 60000 },
  async (t) => {
    const h = await workspace(t);
    await coldOwnedMedia(h);
    const original = await h.adapter.get('products', h.productId);
    // The status handler uses the service clock; a fixed date makes a new run look overdue.
    const at = new Date().toISOString();
    const key = '1'.repeat(64);
    await h.adapter.createDocWithId('alibabaConnections', 'primary', {
      status: 'active',
      accountLabel: 'Local test supplier',
      tokenEnvelope: encryptTokenPayload(Buffer.from(key, 'hex'), {
        accessToken: 'test-source-access',
        refreshToken: 'test-source-refresh',
      }),
      accessTokenExpiresAt: new Date(Date.parse(at) + 2 * 86400000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.parse(at) + 11 * 86400000).toISOString(),
    });
    const config = {
      jwtSecret: 'sync-ui-local-only',
      backgroundSyncEnabled: true,
      appKey: 'local-test',
      appSecret: 'local-test-secret',
      callbackUrl: `${api}/api/alibaba-catalog-sync/oauth/callback`,
      tokenKeyHex: key,
    };
    const token = await signSession(config.jwtSecret, {
      sub: 'admin',
      role: 'admin',
      name: 'Admin',
      email: 'admin@example.test',
    });
    const supplierCalls: string[] = [];
    const providerFetch: typeof fetch = async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      const method = params.get('method') ?? '';
      supplierCalls.push(method);
      assert.ok(params.get('sign'));
      if (method === 'alibaba.icbu.product.list')
        return new Response(
          JSON.stringify({
            result: {
              total_item: 2,
              products: ['sync-test-one', 'sync-test-two']
                .slice(0, Number(params.get('page_size') ?? 30))
                .map((id) => ({ product_id: id })),
            },
          }),
        );
      if (method === 'alibaba.icbu.product.get') {
        const id = params.get('product_id');
        return new Response(
          JSON.stringify({
            result: {
              product: {
                product_id: id,
                subject: `Local supplier ${id}`,
                main_image: { images: { string: [`https://sc04.alicdn.com/${id}.png`] } },
                fob_currency: 'USD',
                min_order_quantity: 1,
                sku_infos: [{ sku_id: 'sku-1', price: '3.00' }],
              },
            },
          }),
        );
      }
      throw Error(`Unexpected supplier operation ${method}`);
    };
    const overrides = { fetchImpl: providerFetch, now: () => at, alert: async () => {} };
    const cache = join(site, 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, 'channel-sync-browser-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      `${dir}/entry.tsx`,
      `import {createElement} from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{AlibabaCatalogSyncPage}from'${root}/apps/site/src/islands/admin/alibaba-catalog-sync/AlibabaCatalogSyncPage.tsx';createRoot(document.getElementById('root')).render(createElement(QueryClientProvider,{client:new QueryClient()},createElement(AlibabaCatalogSyncPage,{onViewProducts:()=>{document.getElementById('products').textContent='Products opened';}})));`,
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      define: {
        'import.meta.env.PUBLIC_API_BASE_URL': JSON.stringify(api),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
      build: {
        outDir: `${dir}/dist`,
        lib: { entry: `${dir}/entry.tsx`, formats: ['es'], fileName: () => 'app.js' },
      },
    });
    const script = await readFile(`${dir}/dist/app.js`, 'utf8');
    const html =
      '<html><div id="root"></div><p id="products"></p><script type="module" src="/app.js"></script></html>';
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.addInitScript(
      ({ token }) => {
        localStorage.setItem('channel.token', token);
        localStorage.setItem(
          'channel.user',
          JSON.stringify({ id: 'admin', role: 'admin', status: 'active', username: 'Admin' }),
        );
      },
      { token },
    );
    const actions: string[] = [];
    const errors: string[] = [];
    let loseReply = true;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin)
        return route.fulfill({
          body: url.pathname.endsWith('.js') ? script : html,
          contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html',
        });
      assert.equal(url.origin, api);
      assert.equal(url.pathname, '/api/alibaba-catalog-sync');
      const body = request.postDataJSON();
      actions.push(body.action);
      const result = await handleAlibabaSyncRequest(body, config, {}, overrides);
      if (body.action === 'startSync' && loseReply) {
        loseReply = false;
        return route.abort('failed');
      }
      return route.fulfill({ status: result.ok ? 200 : 400, json: result });
    });
    let page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/sync-flow/`);
    await expect(page.getByRole('button', { name: 'Sync products', exact: true }))
      .toBeEnabled()
      .catch(async (error) => {
        throw new Error(
          JSON.stringify({ errors, actions, html: await page.locator('body').innerText() }),
          { cause: error },
        );
      });
    for (const label of [
      'Copy photos now',
      'Inspect detail',
      'Create missing drafts',
      'Repair missing quotes',
      'Approve candidate',
    ])
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    assert.equal(actions.includes('startSync'), false);
    assert.equal(supplierCalls.length, 0, 'opening the page is read-only');
    await page.getByRole('button', { name: 'Sync products', exact: true }).click();
    await expect(page.locator('[data-sync-progress]')).toContainText('Syncing product data', {
      timeout: 10000,
    });
    assert.equal(actions.filter((a) => a === 'startSync').length, 1);
    await expect(page.locator('[data-connection-notice]')).toHaveCount(0);
    assert.equal(supplierCalls.length, 0, 'starting only persists the checkpoint');
    await page.close();
    const runtime = resolveRuntime(config, overrides);
    assert.ok(runtime.ok);
    const deps = {
      client: runtime.runtime.deps.client,
      getAccessToken: () => getConnectionAccessToken(runtime.runtime.deps),
      now: () => at,
      alert: async () => {},
    };
    const authority = createCatalogPreparationAuthority({
      secret: config.jwtSecret,
      environmentId: 'sync-browser-local',
    });
    const outcomes: string[] = [];
    let imageFetches = 0;
    for (let n = 0; n < 4; n++) {
      const result = await resumeSyncWorkflow({
        enabled: true,
        runner: deps,
        prepareSource: (input) => prepareSyncedCatalogSource(authority, input),
        photos: (input) =>
          prepareAlibabaPhotosPage({
            ...input,
            importImage: (url) =>
              importCandidateImage(url, {
                now: () => at,
                resolveDns: async () => ['104.16.1.1'],
                fetchImpl: async () => {
                  imageFetches++;
                  return new Response(new Uint8Array(ownedColdPng), {
                    headers: { 'content-type': 'image/png' },
                  });
                },
              }),
          }),
      });
      outcomes.push(result.outcome);
      if (result.outcome === 'complete') break;
    }
    assert.equal(outcomes.at(-1), 'complete', JSON.stringify(outcomes));
    assert.ok(supplierCalls.includes('alibaba.icbu.product.get'));
    assert.equal(imageFetches, 2);
    const rows = await h.adapter.list({
      collection: 'products',
      page: 1,
      pageSize: 20,
      search: '',
    });
    const created = rows.items.filter((row) => row._id !== h.productId);
    assert.equal(created.length, 2);
    for (const row of created) {
      assert.equal(readCurrentCatalogPreparation(row)?.state, 'ready');
      assert.equal(row.published, false);
      assert.notEqual(row.alibabaPhotosPending, true);
      assert.equal(row.productFamily, undefined);
      assert.ok(Array.isArray(row.imageIds) && row.imageIds.length > 0);
    }
    assert.deepEqual(
      await h.adapter.get('products', h.productId),
      original,
      'existing manual product is unchanged',
    );
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/sync-flow/`);
    await expect(page.locator('[data-sync-progress]')).toContainText('Sync complete', {
      timeout: 10000,
    });
    await page.getByRole('button', { name: 'View products', exact: true }).click();
    await expect(page.locator('#products')).toHaveText('Products opened');
    assert.equal(
      actions.filter((a) => a === 'startSync').length,
      1,
      'no automatic replacement request after reply loss or page reopening',
    );
    assert.deepEqual(errors, []);
    const proof = {
      syntheticLocalOnly: true,
      actualUiAndAuthenticatedHandler: true,
      actualRunnerAndRawStorage: true,
      actualProtectedPhotoImport: true,
      actualAutomaticReadiness: true,
      startRequests: 1,
      lostStartReplyRecovered: true,
      pageClosedBeforeSourceWork: true,
      serverOutcomes: outcomes,
      sourceProducts: created.length,
      imageFetches,
      allUnpublished: true,
      noCategoryForced: true,
      originalManualProductUnchanged: true,
      pageErrors: errors,
    };
    if (process.env.SYNC_OPERATOR_TEST_OUTPUT)
      await writeFile(process.env.SYNC_OPERATOR_TEST_OUTPUT, JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  },
);

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { parseDocument } from 'yaml';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';

for (const [scenario, engine] of [
  ['normal', 'chromium'],
  ['lost-save', 'chromium'],
  ['stop-before-start', 'chromium'],
  ['session-reconnect', 'chromium'],
  ['linked', 'chromium'],
  ['category-change', 'chromium'],
  ['unpublish', 'chromium'],
  ['archive', 'chromium'],
  ['linked-archive', 'chromium'],
  ['unknown-availability', 'chromium'],
  ['unknown-unpublish', 'chromium'],
  ['unknown-archive', 'chromium'],
  ['unknown-availability', 'webkit'],
  ['archive', 'webkit'],
  ['normal', 'webkit'],
] as const)
  test(
    `${engine} real live editor ${scenario} keeps its intended lifecycle and classification`,
    { timeout: 90000 },
    async (t) => {
      const h = await workspace(t, scenario.startsWith('linked') ? 105 : undefined, true);
      const media = await coldOwnedMedia(h);
      const initial = await h.start('publish', {});
      const published = await h.invokeWithConfig(
        { ...initial, action: 'product-operation-continue' },
        media.config,
      );
      assert.ok(published.ok, JSON.stringify(published));
      assert.equal(Reflect.get(published.data as object, 'state'), 'complete');
      const before = await h.adapter.get('products', h.productId);
      assert.ok(before);
      const config = {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
        ...media.config,
      };
      const token = await signSession(config.jwtSecret, {
        sub: 'admin',
        email: 'admin@example.test',
        name: 'Admin',
        role: 'admin',
      });
      const dir = await mkdtemp(join(tmpdir(), 'channel-live-editor-'));
      let closeBrowser = async () => {};
      let closeServer = async () => {};
      t.after(async () => {
        await closeBrowser();
        await closeServer();
        await rm(dir, { recursive: true, force: true });
      });
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(dir, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/testing/editor-recovery-browser-harness.tsx'],
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
            name: 'live-editor-i18n',
            enforce: 'pre',
            transform(source, id) {
              if (!id.endsWith('.md') || !id.includes('/src/i18n/content/')) return;
              const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
              assert.ok(match?.[1]);
              const document = parseDocument(match[1], { uniqueKeys: true });
              assert.equal(document.errors.length, 0);
              return {
                code: `export const frontmatter=${JSON.stringify(document.toJSON())};`,
                map: null,
              };
            },
          },
          tailwind(),
          {
            name: 'live-editor-page',
            configureServer(server) {
              server.middlewares.use('/editor-test', (_req, response) => {
                response.setHeader('Content-Type', 'text/html');
                response.end(
                  '<!doctype html><html lang="en"><body><div id="editor-recovery-root"></div></body></html>',
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
      const playwright = await import('@playwright/test');
      const { expect } = playwright;
      const browser = await playwright[engine].launch({ headless: true });
      closeBrowser = () => browser.close();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const calls: { action: string; data?: Record<string, unknown> }[] = [];
      let blockStart = scenario === 'stop-before-start';
      let lost = false;
      if (scenario === 'lost-save') {
        const save = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
        h.adapter.saveCatalogProductWithIdentities = async (input) => {
          const saved = await save(input);
          if (!lost && saved.result === 'saved' && input.expectedOperation) {
            lost = true;
            throw Error('Live browser save committed before its reply was lost');
          }
          return saved;
        };
      }
      await page.route('**/api/admin', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        calls.push(body);
        if (body.action === 'catalogDetailApproval' && body.data?.action === 'preview') {
          await route.fulfill({
            status: 400,
            json: {
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Open the product to repair its preview.',
              },
            },
          });
          return;
        }
        if (blockStart && body.data?.action === 'product-operation-start') {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Original live start did not arrive.' },
            },
          });
          return;
        }
        const result = await handleAdminRequest(body, config);
        await route.fulfill({ status: result.ok ? 200 : 400, json: result });
      });
      await page.route('**/api/products/**', async (route) => {
        assert.equal(route.request().headers().authorization, undefined);
        const url = new URL(route.request().url());
        const result = await handlePublicApiEvent(
          {
            httpMethod: 'GET',
            path: url.pathname,
            queryStringParameters: Object.fromEntries(url.searchParams),
          },
          { enableCatalogDetail: true },
        );
        await route.fulfill({
          status: result.statusCode,
          headers: result.headers,
          body: result.body,
        });
      });
      await page.goto(`${origin}editor-test`);
      const modulePath = '/src/islands/admin/testing/editor-recovery-browser-harness.tsx';
      await page.evaluate(
        async ({ productId, token, modulePath, unknownAvailability }) => {
          const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
            await import(modulePath);
          harness.renderPreview(productId, token, unknownAvailability ? {} : undefined);
        },
        {
          productId: h.productId,
          token,
          modulePath,
          unknownAvailability: scenario.startsWith('unknown'),
        },
      );
      await page.getByRole('button', { name: 'Open item to repair', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Repair saved product', exact: true });
      await expect(form).toBeVisible();
      if (scenario.startsWith('unknown')) await expect(form.locator('#name')).toBeEditable();
      await form.locator('#name').fill('Live browser clock');
      await form.locator('#description').fill('Private live browser edit');
      await expect(form.locator('#published')).toBeChecked();
      if (scenario === 'category-change')
        await form.locator('#productFamily').selectOption('headphones');
      if (scenario.endsWith('unpublish')) await form.locator('#published').uncheck();
      if (scenario.endsWith('archive')) await form.locator('#archived').check();
      if (scenario === 'session-reconnect') {
        const changeSession = async (actorId: string) =>
          page.evaluate(
            async ({ token, actorId, modulePath }) => {
              const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
                await import(modulePath);
              harness.setEditorSession(token, actorId);
            },
            { token, actorId, modulePath },
          );
        await changeSession('another-admin');
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await form.getByRole('button', { name: 'Reconnect original account', exact: true }).click();
        await expect(
          form.getByText(
            'Return to the original account and API environment to reconnect this form.',
            { exact: true },
          ),
        ).toBeVisible();
        assert.equal(
          calls.filter((call) => call.data?.action === 'product-operation-start').length,
          0,
        );
        await changeSession('admin');
        await form.getByRole('button', { name: 'Reconnect original account', exact: true }).click();
        await expect(form.locator('#name')).toHaveValue('Live browser clock');
        await expect(form.locator('#description')).toHaveValue('Private live browser edit');
      }
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      if (scenario === 'stop-before-start') {
        await expect(
          form.getByRole('button', { name: 'Stop original publication', exact: true }),
        ).toBeEnabled();
        assert.deepEqual(await h.adapter.get('products', h.productId), before);
        await form.getByRole('button', { name: 'Stop original publication', exact: true }).click();
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        await expect(form.locator('#name')).toHaveValue('Live browser clock');
        await expect(form.locator('#description')).toHaveValue('Private live browser edit');
        blockStart = false;
        await form.getByRole('button', { name: 'Save', exact: true }).click();
      }
      if (scenario === 'unknown-availability') {
        await expect(form.locator('#name')).toHaveValue('Live browser clock');
        await expect(
          form.getByText(
            'Publishing availability could not be confirmed. Your edits have been kept. Retry the availability check.',
            { exact: true },
          ),
        ).toBeVisible();
        assert.equal(
          calls.filter(
            (call) => call.action === 'update' || call.data?.action === 'product-operation-start',
          ).length,
          0,
        );
        assert.deepEqual(await h.adapter.get('products', h.productId), before);
        await form
          .getByRole('button', { name: 'Check save availability again', exact: true })
          .click();
        await expect(
          form.getByRole('button', { name: 'Check save availability again', exact: true }),
        ).toHaveCount(0);
        await expect(form.locator('#name')).toHaveValue('Live browser clock');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
      }
      const withdrawing = scenario.endsWith('unpublish') || scenario.endsWith('archive');
      await expect(
        page.getByText(withdrawing ? 'Draft saved' : 'Product published', { exact: true }),
      ).toBeVisible({
        timeout: 20000,
      });
      const current = await h.adapter.get('products', h.productId);
      assert.equal(current?.published, !withdrawing);
      assert.equal(current?.archived === true, scenario.endsWith('archive'));
      assert.equal(current?.name, 'Live browser clock');
      assert.equal(current?.description, 'Private live browser edit');
      for (const key of ['productFamily', 'category', 'subcategoryIds']) {
        if (scenario === 'category-change' && key === 'productFamily')
          assert.equal(current?.[key], 'headphones');
        else assert.deepEqual(current?.[key], before[key]);
      }
      const starts = calls.filter((call) => call.data?.action === 'product-operation-start');
      assert.equal(starts.length, withdrawing ? 0 : scenario === 'stop-before-start' ? 2 : 1);
      assert.ok(starts.every((call) => call.data?.intent === 'refresh-live'));
      const updates = calls.filter((call) => call.action === 'update');
      assert.equal(updates.length, withdrawing ? 1 : 0);
      if (withdrawing) {
        assert.equal(updates[0]?.data?.expectedUpdatedAt, before.updatedAt);
        if (scenario.startsWith('unknown'))
          assert.equal(
            calls.filter((call) => call.action === 'catalogDetailCapabilities').length,
            0,
          );
        assert.equal(
          calls.filter(
            (call) =>
              call.action === 'catalogDetailApproval' &&
              !['preview', 'supplier-review', 'photo-sources'].includes(String(call.data?.action)),
          ).length,
          0,
        );
      }
      if (scenario === 'category-change')
        assert.equal(Reflect.get(starts[0]?.data?.values as object, 'published'), undefined);
      if (scenario === 'lost-save') assert.equal(lost, true);
      assert.deepEqual(errors, []);
      const result = await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
        { enableCatalogDetail: true },
      );
      assert.equal(result.statusCode, withdrawing ? 404 : 200);
      if (!withdrawing) {
        const detail = decodeCatalogDetailView(JSON.parse(result.body).data);
        assert.ok(detail.ok);
        assert.equal(detail.value.name, 'Live browser clock');
      }
      // Restore the test product through the native mutation path before releasing its temporary storage.
      assert.equal(
        (
          await h.adapter.saveCatalogProductWithIdentities({
            mode: 'update',
            productId: h.productId,
            data: { published: false },
          })
        ).result,
        'saved',
      );
      assert.equal((await h.adapter.get('products', h.productId))?.published, false);
    },
  );

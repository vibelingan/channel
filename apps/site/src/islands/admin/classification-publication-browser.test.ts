import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  ownedColdPng,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { PublicationCheckpointSchema } from './catalog-product-operation-api.ts';

for (const engine of ['chromium', 'webkit'] as const)
  test(
    `${engine} actual classification editor uses owned publication, original recovery, and scoped restoration`,
    { timeout: 180000 },
    async (t) => {
      const h = await workspace(t);
      const original = await h.adapter.get('products', h.productId);
      assert.ok(original);
      const media = await coldOwnedMedia(h);
      const warm = await h.start('publish', {});
      assert.ok(
        (await h.invokeWithConfig({ ...warm, action: 'product-operation-continue' }, media.config))
          .ok,
      );
      assert.ok((await h.invoke({ ...warm, action: 'product-operation-cancel' })).ok);
      const token = await signSession('owned-continue-test-only', {
        sub: 'admin',
        role: 'admin',
        name: 'Admin',
        email: 'admin@example.test',
      });
      const config = {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
        ...media.config,
      };
      const coldObject = await media.storage.putObject({
        namespace: 'catalog',
        logicalId: 'cold-image',
        fileName: 'cold.png',
        mimeType: 'image/png',
        content: ownedColdPng,
      });
      const groups = {
        twenty: 20,
        cold: 20,
        preserve: 20,
        preservepartial: 3,
        preservelost: 1,
        preserveconflict: 1,
        lost: 1,
        cancel: 1,
        partial: 2,
        auth: 1,
        conflict: 1,
        storage: 1,
        draft: 1,
        disabled: 1,
        availability: 1,
      };
      const manifest = Object.entries(groups).flatMap(([group, count]) =>
        Array.from({ length: count }, (_, index) => ({
          ...original,
          _id: `${engine}-${group}-${index}`,
          name: `Actual ${group} clock ${index}`,
          subcategoryIds: [],
          ...(group === 'partial' && index === 1 ? { imageIds: [] } : {}),
          ...(group === 'cold' ? { imageIds: ['cold-image'] } : {}),
          ...(group === 'preserve' && index % 2
            ? {
                productFamily: 'headphones',
                category: 'wired',
                subcategoryIds: ['headphones-wired'],
              }
            : {}),
        })),
      );
      for (const product of manifest.filter((item) => item._id.includes('-preserve'))) {
        const index = Number(product._id.split('-').at(-1));
        if (index % 4 === 0) Reflect.deleteProperty(product, 'subcategoryIds');
        if (index % 4 === 2) {
          Reflect.set(product, 'productFamily', 'headphones');
          Reflect.set(product, 'category', 'wired');
          Reflect.deleteProperty(product, 'subcategoryIds');
        }
        if (product._id.includes('-preservepartial-') && index === 2)
          for (const field of ['productFamily', 'category', 'subcategoryIds'])
            Reflect.deleteProperty(product, field);
      }
      const rows = JSON.parse(h.bytes());
      rows.products.push(...manifest);
      rows.images.push({
        _id: 'cold-image',
        status: 'active',
        ...coldObject,
        mimeType: 'image/png',
        byteSize: ownedColdPng.byteLength,
        checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
        publishedRefCount: 0,
      });
      writeFileSync(h.file, JSON.stringify(rows));
      const directory = await mkdtemp(join(tmpdir(), 'channel-classification-ui-'));
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const { chromium, webkit, expect } = await import('@playwright/test');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(directory, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/testing/classification-publication-browser-harness.tsx'],
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            '@tanstack/react-query',
            'zod',
          ],
        },
        plugins: [
          tailwind(),
          {
            name: 'owned-classification-fixture',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                const url = new URL(request.url ?? '/', 'http://fixture');
                if (url.pathname === '/classification-test') {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(
                    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="classification-publication-root"></main><script type="module" src="/src/islands/admin/testing/classification-publication-browser-harness.tsx"></script></body></html>',
                  );
                } else if (url.pathname === '/classification-products') {
                  const group = url.searchParams.get('group') ?? 'twenty';
                  response.setHeader('Content-Type', 'application/json');
                  Promise.all(
                    manifest
                      .filter((p) => p._id.includes(`-${group}-`))
                      .map((p) => h.adapter.get('products', p._id)),
                  )
                    .then((products) => response.end(JSON.stringify(products)))
                    .catch((error) => {
                      response.statusCode = 500;
                      response.end(String(error));
                    });
                } else next();
              });
            },
          },
        ],
        server: { host: '127.0.0.1', port: 0 },
      });
      let closeBrowser = async () => {};
      t.after(async () => {
        await closeBrowser();
        await server.close();
        await rm(directory, { recursive: true, force: true });
      });
      await server.listen();
      const origin = server.resolvedUrls?.local[0];
      assert.ok(origin);
      const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
      closeBrowser = () => browser.close();
      const context = await browser.newContext({
        viewport:
          engine === 'chromium' ? { width: 1280, height: 900 } : { width: 390, height: 844 },
      });
      t.after(() => context.close());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const actions: { action: string; data: Record<string, unknown> }[] = [];
      const starts = new Map<string, string>();
      let blockPublic = false;
      let loseCommit = false;
      let pauseContinuation = false;
      let concurrentEdit = false;
      let capabilityUnavailable = false;
      let capabilityWait: Promise<void> | undefined;
      await context.addInitScript(
        ({ token }) => {
          localStorage.setItem('channel.token', token);
          localStorage.setItem(
            'channel.user',
            JSON.stringify({
              id: 'admin',
              role: 'admin',
              username: 'Admin',
              email: 'admin@example.test',
            }),
          );
        },
        { token },
      );
      await page.route('**/api/admin', async (route) => {
        const input = route.request().postDataJSON();
        const data = input.data ?? {};
        actions.push({ action: input.action, data });
        if (input.action === 'catalogDetailCapabilities' && capabilityWait) await capabilityWait;
        if (input.action === 'catalogDetailCapabilities' && capabilityUnavailable) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Controlled unavailable capability' },
            },
          });
          return;
        }
        if (input.action === 'catalogDetailApproval' && data.action === 'product-operation-start') {
          assert.equal(
            starts.has(data.productId),
            false,
            'No replacement operation may be started for a selected product',
          );
          starts.set(data.productId, data.operationId);
          if (concurrentEdit) {
            concurrentEdit = false;
            const changed = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id: data.productId,
                  values: { description: 'Concurrent independent draft edit' },
                },
              },
              config,
            );
            assert.ok(changed.ok, JSON.stringify(changed));
          }
        }
        if (
          pauseContinuation &&
          input.action === 'catalogDetailApproval' &&
          data.action === 'product-operation-continue'
        ) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Controlled paused continuation' },
            },
          });
          return;
        }
        const result = await handleAdminRequest(input, config);
        if (
          loseCommit &&
          input.action === 'catalogDetailApproval' &&
          data.action === 'product-operation-continue' &&
          result.ok &&
          result.data &&
          typeof result.data === 'object' &&
          Reflect.get(result.data, 'state') === 'complete'
        ) {
          loseCommit = false;
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Controlled lost completed reply' },
            },
          });
          return;
        }
        await route.fulfill({
          status: result.ok ? 200 : result.error.code === 'UNAUTHORIZED' ? 401 : 400,
          json: result,
        });
      });
      await page.route('**/api/products/**', async (route) => {
        if (blockPublic) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Controlled public read unavailable' },
            },
          });
          return;
        }
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
          body: result.body,
          headers: result.headers,
        });
      });
      const open = async (group: string) => {
        blockPublic = false;
        loseCommit = false;
        pauseContinuation = false;
        await page.goto(new URL(`classification-test?group=${group}`, origin).href);
        await expect(
          page.getByRole('button', { name: 'Save and publish', exact: true }),
        ).toBeEnabled();
      };
      const keep = async () => {
        await page
          .getByRole('combobox', { name: 'Assignment mode', exact: true })
          .and(page.locator('button'))
          .click();
        await page
          .getByRole('option', { name: 'Keep existing classifications', exact: true })
          .click();
      };
      const publish = async () => {
        await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm save and publish', exact: true }).click();
      };
      const capture = async (name: string) => {
        if (process.env.CLASSIFICATION_UI_EVIDENCE !== '1') return;
        const dir = fileURLToPath(
          new URL(
            '../../../../../output/pricing-clock-repair-2026-10-13/p3e1/classification-owned-ui/',
            import.meta.url,
          ),
        );
        await mkdir(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `${engine}-${name}.png`) });
      };
      try {
        await t.test(
          '20 actual drafts publish through saved classification receipts and anonymous detail checks',
          async () => {
            await open('twenty');
            await publish();
            await expect(
              page.getByText('20 products classified and published.', { exact: true }),
            ).toBeVisible({ timeout: 60000 });
            await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
            assert.equal(starts.size, 20);
            assert.equal(
              actions.filter(
                (a) =>
                  a.action === 'update' &&
                  a.data.values &&
                  typeof a.data.values === 'object' &&
                  Reflect.get(a.data.values, 'published') === true,
              ).length,
              0,
            );
            for (const product of manifest.filter((p) => p._id.includes('-twenty-'))) {
              const saved = await h.adapter.get('products', product._id);
              assert.equal(saved?.published, true);
              assert.equal(saved?.productFamily, 'misc');
              assert.deepEqual(saved?.subcategoryIds, []);
            }
            await capture('twenty');
            await page.getByRole('button', { name: 'Done', exact: true }).click();
            await expect(page.getByText('Classification closed')).toBeVisible();
          },
        );
        await t.test(
          '20 actual cold-image drafts finish the full classification and publication flow',
          async () => {
            await open('cold');
            await publish();
            await expect(
              page.getByText('20 products classified and published.', { exact: true }),
            ).toBeVisible({ timeout: 60000 });
            await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
            assert.equal(starts.size, 40);
            for (const product of manifest.filter((p) => p._id.includes('-cold-')))
              assert.equal((await h.adapter.get('products', product._id))?.published, true);
            await capture('cold-twenty');
            await page.getByRole('button', { name: 'Done', exact: true }).click();
            await expect(page.getByText('Classification closed')).toBeVisible();
          },
        );
        await t.test(
          '20 mixed-classification drafts keep each category without any assignment RPC, publish and read back original receipts',
          async () => {
            await open('preserve');
            const assignmentsBefore = actions.filter(
              (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
            ).length;
            const startsBefore = starts.size;
            await keep();
            await expect(
              page.getByRole('button', { name: 'Save classification', exact: true }),
            ).toBeDisabled();
            await expect(page.getByLabel('Selected product preview')).toContainText('Wired');
            await publish();
            await expect(
              page.getByText('20 products published. Existing classifications were kept.', {
                exact: true,
              }),
            ).toBeVisible({ timeout: 60000 });
            await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
            assert.equal(starts.size - startsBefore, 20);
            assert.equal(
              actions.filter(
                (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
              ).length,
              assignmentsBefore,
            );
            for (const before of manifest.filter((p) => p._id.includes('-preserve-'))) {
              const after = await h.adapter.get('products', before._id);
              assert.ok(after);
              assert.equal(after.published, true);
              for (const field of ['productFamily', 'category', 'subcategoryIds']) {
                assert.equal(
                  Object.hasOwn(after, field),
                  Object.hasOwn(before, field),
                  `${before._id}: ${field} presence`,
                );
                assert.deepEqual(Reflect.get(after ?? {}, field), Reflect.get(before, field));
              }
            }
            await capture('preserved-twenty');
            await page.getByRole('button', { name: 'Done', exact: true }).click();
          },
        );
        await t.test(
          'keeping categories publishes valid siblings and leaves a missing category untouched',
          async () => {
            await open('preservepartial');
            await keep();
            const assignmentsBefore = actions.filter(
              (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
            ).length;
            await publish();
            await expect(
              page.getByText(
                '2 of 3 published. Existing classifications were kept; check the results below.',
                { exact: true },
              ),
            ).toBeVisible({ timeout: 30000 });
            await expect(page.locator('section[role="alert"]')).toContainText(
              'Choose a website category before publishing.',
            );
            assert.equal(
              actions.filter(
                (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
              ).length,
              assignmentsBefore,
            );
            const missing = await h.adapter.get('products', `${engine}-preservepartial-2`);
            assert.ok(missing);
            assert.equal(missing.published, false);
            for (const field of ['productFamily', 'category', 'subcategoryIds'])
              assert.equal(Object.hasOwn(missing, field), false);
          },
        );
        await t.test(
          'kept-classification publication recovers a lost reply by reading the same original without assignment',
          async () => {
            await open('preservelost');
            await keep();
            blockPublic = true;
            loseCommit = true;
            const assignmentsBefore = actions.filter(
              (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
            ).length;
            await publish();
            await expect(page.getByText(/couldn.t be checked/)).toBeVisible({ timeout: 30000 });
            const startsBefore = starts.size;
            const writesBefore = actions.filter(
              (a) =>
                a.action === 'catalogDetailApproval' && a.data.action !== 'product-operation-get',
            ).length;
            blockPublic = false;
            await page
              .getByRole('button', { name: 'Check original publication', exact: true })
              .click();
            await expect(
              page.getByText('1 product published. Existing classifications were kept.', {
                exact: true,
              }),
            ).toBeVisible();
            await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
            assert.equal(starts.size, startsBefore);
            assert.equal(
              actions.filter(
                (a) =>
                  a.action === 'catalogDetailApproval' && a.data.action !== 'product-operation-get',
              ).length,
              writesBefore,
            );
            assert.equal(
              actions.filter(
                (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
              ).length,
              assignmentsBefore,
            );
          },
        );
        await t.test(
          'kept-classification publication refuses a draft edited after the reviewed selection',
          async () => {
            await open('preserveconflict');
            await keep();
            concurrentEdit = true;
            const assignmentsBefore = actions.filter(
              (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
            ).length;
            await publish();
            await expect(page.locator('section[role="alert"]')).toContainText(
              'The reviewed product changed. Refresh and review it again.',
            );
            assert.equal(
              (await h.adapter.get('products', `${engine}-preserveconflict-0`))?.published,
              false,
            );
            assert.equal(
              actions.filter(
                (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
              ).length,
              assignmentsBefore,
            );
          },
        );
        await t.test(
          'lost completed reply and unavailable website remain unconfirmed across reload and recover with no new assignment or operation',
          async () => {
            await open('lost');
            loseCommit = true;
            blockPublic = true;
            await publish();
            await expect(page.getByText(/couldn.t be checked/)).toBeVisible({ timeout: 30000 });
            await capture('unknown');
            const before = actions.filter(
              (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
            ).length;
            const startCount = starts.size;
            await page.reload();
            await expect(
              page.getByRole('button', { name: 'Save and publish', exact: true }),
            ).toBeDisabled();
            await page
              .getByRole('button', { name: 'Recover original publication', exact: true })
              .click();
            await expect(page.getByText(/have original publication tasks/)).toBeVisible();
            await expect(
              page.getByRole('button', { name: 'Confirm save and publish', exact: true }),
            ).toHaveCount(0);
            await page.getByRole('button', { name: 'Show recovery record' }).click();
            await expect(
              page.getByRole('textbox', { name: 'Publication recovery record' }),
            ).toHaveValue(/operationId/);
            blockPublic = false;
            const writesBefore = actions.filter(
              (a) =>
                a.action === 'catalogDetailApproval' && a.data.action !== 'product-operation-get',
            ).length;
            await page
              .getByRole('button', { name: 'Check original publication', exact: true })
              .click();
            await expect(page.getByText(/1 original publication confirmed/)).toBeVisible();
            await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
            assert.equal(
              actions.filter(
                (a) => a.action === 'catalogCategories' && a.data.kind === 'assignment',
              ).length,
              before,
            );
            assert.equal(starts.size, startCount);
            assert.equal(
              actions.filter(
                (a) =>
                  a.action === 'catalogDetailApproval' && a.data.action !== 'product-operation-get',
              ).length,
              writesBefore,
            );
            await capture('recovered');
          },
        );
        await t.test(
          'stop original private operation leaves the draft unpublished and does not pretend to undo classification',
          async () => {
            await open('cancel');
            pauseContinuation = true;
            await publish();
            await expect(
              page.getByRole('button', { name: 'Stop original publication', exact: true }),
            ).toBeEnabled({ timeout: 30000 });
            pauseContinuation = false;
            await page
              .getByRole('button', { name: 'Stop original publication', exact: true })
              .click();
            await expect(page.getByRole('alert')).toContainText(
              'Publication stopped. Saved draft changes remain.',
            );
            const product = manifest.find((p) => p._id.includes('-cancel-'));
            assert.ok(product);
            assert.equal((await h.adapter.get('products', product._id))?.published, false);
            await capture('stopped');
          },
        );
        await t.test(
          'a missing image is a per-product rejection while its valid sibling publishes',
          async () => {
            await open('partial');
            await publish();
            await expect(
              page.getByText('1 published · 1 not published', { exact: true }),
            ).toBeVisible({ timeout: 30000 });
            await expect(page.getByRole('alert')).toContainText(/Photos contains an invalid value/);
            await capture('partial');
            const siblings = manifest.filter((p) => p._id.includes('-partial-'));
            assert.equal(
              (await h.adapter.get('products', siblings[0]?._id ?? ''))?.published,
              true,
            );
            assert.equal(
              (await h.adapter.get('products', siblings[1]?._id ?? ''))?.published,
              false,
            );
          },
        );
        await t.test(
          'switching account after preview prevents classification and publication writes',
          async () => {
            await open('auth');
            await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
            const before = actions.length;
            const startCount = starts.size;
            await page.evaluate(() => {
              localStorage.setItem('channel.token', 'other-account-token');
              localStorage.setItem('channel.user', JSON.stringify({ id: 'other', role: 'admin' }));
            });
            await page
              .getByRole('button', { name: 'Confirm save and publish', exact: true })
              .click();
            await expect(page.getByText(/Return to the original account/)).toBeVisible();
            assert.equal(actions.length, before);
            assert.equal(starts.size, startCount);
            const product = manifest.find((p) => p._id.includes('-auth-'));
            assert.ok(product);
            assert.equal(
              (await h.adapter.get('products', product._id))?.updatedAt,
              product.updatedAt,
            );
          },
        );
        await t.test(
          'concurrent independent draft edits reject the saved classification revision',
          async () => {
            await open('conflict');
            concurrentEdit = true;
            await publish();
            await expect(
              page.getByText('0 published · 1 not published', { exact: true }),
            ).toBeVisible();
            const product = manifest.find((p) => p._id.includes('-conflict-'));
            assert.ok(product);
            const current = await h.adapter.get('products', product._id);
            assert.equal(current?.published, false);
            assert.equal(current?.description, 'Concurrent independent draft edit');
            assert.equal(current?.catalogDetailApprovalReceipt, undefined);
          },
        );
        await t.test(
          'recovery storage failure prevents publication, offers export, and continues same attempt after recovery',
          async () => {
            await open('storage');
            await page.evaluate(() => {
              const before = Storage.prototype.setItem;
              Reflect.set(window, '__restoreRecoveryStorage', () => {
                Storage.prototype.setItem = before;
              });
              Storage.prototype.setItem = function (key, value) {
                if (key.startsWith('channel:publication:'))
                  throw new DOMException('Quota', 'QuotaExceededError');
                return before.call(this, key, value);
              };
            });
            const startCount = starts.size;
            await publish();
            await expect(
              page.getByText(/Keep the recovery export and allow browser storage/),
            ).toBeVisible();
            assert.equal(starts.size, startCount);
            await page.getByRole('button', { name: 'Show recovery record', exact: true }).click();
            const bytes = await page
              .getByRole('textbox', { name: 'Publication recovery record' })
              .inputValue();
            const exported = z
              .object({ entries: z.array(PublicationCheckpointSchema) })
              .parse(JSON.parse(bytes));
            const originalId = exported.entries.find((entry) =>
              entry.scope.productId.includes('-storage-'),
            )?.scope.operationId;
            assert.equal(typeof originalId, 'string');
            await page.evaluate(() => {
              const restore = Reflect.get(window, '__restoreRecoveryStorage');
              if (typeof restore !== 'function') throw Error('Missing recovery restore');
              restore();
            });
            await page
              .getByRole('button', { name: 'Continue original publication', exact: true })
              .click();
            await expect(
              page.getByText('1 product classified and published.', { exact: true }),
            ).toBeVisible({ timeout: 30000 });
            const product = manifest.find((p) => p._id.includes('-storage-'));
            assert.ok(product);
            assert.equal(starts.get(product._id), originalId);
          },
        );
        await t.test(
          'classification-only save closes after readback without publication',
          async () => {
            await open('draft');
            const startCount = starts.size;
            await page.getByRole('button', { name: 'Save classification', exact: true }).click();
            await page.getByRole('button', { name: 'Confirm save', exact: true }).click();
            await expect(page.getByText('Classification closed')).toBeVisible();
            assert.equal(starts.size, startCount);
            const product = manifest.find((p) => p._id.includes('-draft-'));
            assert.ok(product);
            const current = await h.adapter.get('products', product._id);
            assert.equal(current?.published, false);
            assert.notEqual(current?.updatedAt, product.updatedAt);
          },
        );
        await t.test(
          'disabled publication capability blocks publish before classification and still permits draft save',
          async () => {
            config.enableDetailApproval = false;
            try {
              await page.goto(new URL('classification-test?group=disabled', origin).href);
              await expect(
                page.getByRole('button', { name: 'Save classification', exact: true }),
              ).toBeEnabled();
              await expect(
                page.getByRole('button', { name: 'Save and publish', exact: true }),
              ).toBeDisabled();
              await expect(
                page.getByText('Publishing is unavailable. You can still save classification.', {
                  exact: true,
                }),
              ).toBeVisible();
              await capture('availability-disabled');
              const startsBefore = starts.size;
              await page.getByRole('button', { name: 'Save classification', exact: true }).click();
              await page.getByRole('button', { name: 'Confirm save', exact: true }).click();
              await expect(page.getByText('Classification closed')).toBeVisible();
              assert.equal(starts.size, startsBefore);
            } finally {
              config.enableDetailApproval = true;
            }
          },
        );
        await t.test(
          'unavailable capability blocks publication and has a read-only retry without saving classification',
          async () => {
            capabilityUnavailable = true;
            try {
              const assignmentsBefore = actions.filter(
                (item) => item.action === 'catalogCategories' && item.data.kind === 'assignment',
              ).length;
              const startsBefore = starts.size;
              await page.goto(new URL('classification-test?group=availability', origin).href);
              await expect(
                page.getByRole('button', { name: 'Save classification', exact: true }),
              ).toBeEnabled();
              await expect(
                page.getByRole('button', { name: 'Save and publish', exact: true }),
              ).toBeDisabled();
              await expect(page.getByRole('alert')).toContainText(
                'Publication availability could not be checked.',
              );
              capabilityUnavailable = false;
              await page
                .getByRole('button', { name: 'Check publication availability again', exact: true })
                .click();
              await expect(
                page.getByRole('button', { name: 'Save and publish', exact: true }),
              ).toBeEnabled();
              assert.equal(starts.size, startsBefore);
              await page.getByRole('button', { name: 'Cancel', exact: true }).click();
              await expect(page.getByText('Classification closed')).toBeVisible();
              await page.evaluate(() => {
                const original = Date.now;
                Reflect.set(window, '__restoreCapabilityTime', () => {
                  Date.now = original;
                });
                Date.now = () => original() + 61001;
              });
              capabilityUnavailable = true;
              let releaseCapability = () => {};
              capabilityWait = new Promise<void>((resolve) => {
                releaseCapability = resolve;
              });
              const readsBefore = actions.filter(
                (item) => item.action === 'catalogDetailCapabilities',
              ).length;
              try {
                await page
                  .getByRole('button', { name: 'Reopen classification', exact: true })
                  .click();
                await expect
                  .poll(
                    () =>
                      actions.filter((item) => item.action === 'catalogDetailCapabilities').length,
                  )
                  .toBeGreaterThan(readsBefore);
                await expect(
                  page.getByRole('button', { name: 'Save classification', exact: true }),
                ).toBeEnabled();
                await expect(
                  page.getByText('Checking publication availability...', { exact: true }),
                ).toBeVisible();
                await expect(
                  page.getByRole('button', { name: 'Save and publish', exact: true }),
                ).toBeDisabled();
                releaseCapability();
                capabilityWait = undefined;
                await expect(page.getByRole('alert')).toContainText(
                  'Publication availability could not be checked.',
                );
                await expect(
                  page.getByRole('button', { name: 'Save and publish', exact: true }),
                ).toBeDisabled();
                await capture('availability-cached-error');
                capabilityUnavailable = false;
                await page
                  .getByRole('button', {
                    name: 'Check publication availability again',
                    exact: true,
                  })
                  .click();
                await expect(
                  page.getByRole('button', { name: 'Save and publish', exact: true }),
                ).toBeEnabled();
              } finally {
                releaseCapability();
                capabilityWait = undefined;
              }
              assert.equal(
                actions.filter(
                  (item) => item.action === 'catalogCategories' && item.data.kind === 'assignment',
                ).length,
                assignmentsBefore,
              );
            } finally {
              capabilityUnavailable = false;
              await page.evaluate(() => {
                const restore = Reflect.get(window, '__restoreCapabilityTime');
                if (typeof restore === 'function') restore();
              });
            }
          },
        );
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      } finally {
        blockPublic = false;
        pauseContinuation = false;
        await page.unrouteAll({ behavior: 'wait' });
        for (const product of manifest) {
          const current = await h.adapter.get('products', product._id);
          assert.ok(current);
          const operationId = starts.get(product._id);
          if (current.published === true) {
            assert.ok(operationId);
            assert.equal(
              current.catalogDetailApprovalReceipt &&
                typeof current.catalogDetailApprovalReceipt === 'object'
                ? Reflect.get(current.catalogDetailApprovalReceipt, 'operationId')
                : undefined,
              operationId,
            );
            const restored = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id: product._id,
                  values: { published: false },
                  expectedUpdatedAt: current.updatedAt,
                },
              },
              config,
            );
            assert.ok(restored.ok, JSON.stringify(restored));
          } else if (operationId) {
            const result = await handleAdminRequest(
              {
                action: 'catalogDetailApproval',
                token,
                data: { action: 'product-operation-get', productId: product._id, operationId },
              },
              config,
            );
            if (result.ok) {
              const status = CatalogProductOperationStatusSchema.parse(result.data);
              if (status.state !== 'complete' && !status.cancelledAt)
                assert.ok(
                  (
                    await handleAdminRequest(
                      {
                        action: 'catalogDetailApproval',
                        token,
                        data: {
                          action: 'product-operation-cancel',
                          productId: status.productId,
                          operationId: status.operationId,
                          inputDigest: status.inputDigest,
                        },
                      },
                      config,
                    )
                  ).ok,
                );
            }
          }
          assert.equal((await h.adapter.get('products', product._id))?.published, false);
          if (product._id.includes('-preserve')) {
            const restored = await h.adapter.get('products', product._id);
            assert.ok(restored);
            for (const field of ['productFamily', 'category', 'subcategoryIds']) {
              assert.equal(Object.hasOwn(restored, field), Object.hasOwn(product, field));
              assert.deepEqual(restored[field], Reflect.get(product, field));
            }
          }

          assert.equal(
            (
              await handlePublicApiEvent(
                { httpMethod: 'GET', path: `/api/products/${product._id}/detail` },
                { enableCatalogDetail: true },
              )
            ).statusCode,
            404,
          );
        }
        const reference = await h.adapter.readCatalogImageReference({
          action: 'read',
          imageId: 'image',
        });
        assert.ok(reference.state === 'counted');
        assert.equal(reference.effectiveCount, 0);
        const coldReference = await h.adapter.readCatalogImageReference({
          action: 'read',
          imageId: 'cold-image',
        });
        assert.ok(coldReference.state === 'counted');
        assert.equal(coldReference.effectiveCount, 0);
        assert.equal(
          (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/cold-image' }, {}))
            .statusCode,
          404,
        );
        assert.equal(
          (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {}))
            .statusCode,
          404,
        );
      }
    },
  );

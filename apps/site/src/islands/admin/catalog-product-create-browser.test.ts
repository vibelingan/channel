import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';

for (const engine of ['chromium', 'webkit'] as const)
  test(
    `${engine} product creation form saves once, recovers its original draft and preserves edits`,
    { timeout: 90000 },
    async (t) => {
      const h = await workspace(t, 0, true);
      const media = await coldOwnedMedia(h);
      const directory = await mkdtemp(join(tmpdir(), 'channel-product-create-ui-'));
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const { chromium, webkit, expect } = await import('@playwright/test');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(directory, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/testing/product-create-browser-harness.tsx'],
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
            name: 'product-create-fixture',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                if (request.url?.startsWith('/create-test')) {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(
                    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="product-create-root"></main><script type="module" src="/src/islands/admin/testing/product-create-browser-harness.tsx"></script></body></html>',
                  );
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
      const page = await browser.newPage({
        viewport: engine === 'webkit' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const token = await signSession('owned-continue-test-only', {
        sub: 'admin',
        role: 'admin',
        name: 'Admin',
        email: 'admin@example.test',
      });
      await page.addInitScript((token) => {
        localStorage.setItem('channel.token', token);
        localStorage.setItem(
          'channel.user',
          JSON.stringify({
            id: 'admin',
            role: 'admin',
            name: 'Admin',
            email: 'admin@example.test',
          }),
        );
      }, token);
      let lose: 'none' | 'start' | 'both' = 'none';
      const starts: { attemptId: string; productId: string }[] = [];
      let dropPublicationStart = false;
      let blockPublic = false;
      let approvalsEnabled = true;
      const publicationCommands: { action: string; operationId: string; productId: string }[] = [];
      const legacyWrites: string[] = [];
      const failures: unknown[] = [];
      const commands: string[] = [];
      await page.route('**/api/admin', async (route) => {
        const input = route.request().postDataJSON();
        if (
          input.action === 'update' ||
          (input.action === 'catalogDetailApproval' &&
            !String(input.data?.action).startsWith('product-operation-'))
        )
          legacyWrites.push(input.action);
        if (String(input.data?.action).startsWith('product-operation-'))
          publicationCommands.push(input.data);
        if (dropPublicationStart && input.data?.action === 'product-operation-start') {
          dropPublicationStart = false;
          await route.abort('failed');
          return;
        }
        const reply = await handleAdminRequest(input, {
          jwtSecret: 'owned-continue-test-only',
          enableDetailApproval: approvalsEnabled,
          ...media.config,
        });
        if (!reply.ok)
          failures.push({ action: input.data?.action ?? input.action, error: reply.error });
        if (input.action === 'catalogProductCreate') {
          commands.push(input.data.action);
          if (reply.ok && input.data.action === 'start')
            starts.push({
              attemptId: input.data.attemptId,
              productId: String(Reflect.get(reply.data as object, 'productId')),
            });
          if (lose === 'both' || (lose === 'start' && input.data.action === 'start')) {
            if (lose === 'start') lose = 'none';
            await route.abort('failed');
            return;
          }
        }
        await route.fulfill({ json: reply });
      });
      await page.route('**/api/products/**', async (route) => {
        assert.equal(route.request().method(), 'GET');
        assert.equal(route.request().headers().authorization, undefined);
        if (blockPublic) {
          await route.abort('failed');
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
          headers: result.headers,
          body: result.body,
        });
      });
      const open = async (image = false) => {
        await page.goto(`${origin}create-test${image ? '?withImage=1' : ''}`);
        await expect(page.getByRole('dialog', { name: 'New Product', exact: true })).toBeVisible();
        assert.deepEqual(errors, []);
      };
      const fill = async (name: string) => {
        await page
          .getByRole('dialog', { name: 'New Product', exact: true })
          .locator('#name')
          .fill(name);
      };
      const save = () => page.getByRole('button', { name: 'Save', exact: true }).click();
      const count = async () =>
        (await h.adapter.list({ collection: 'products', page: 1, pageSize: 100, search: '' }))
          .total;
      const originalCount = await count();
      try {
        await t.test('lost committed response recovers without another create', async () => {
          lose = 'start';
          await open();
          await fill(`${engine} recovered clock`);
          await save();
          await expect(page.getByRole('heading', { name: 'Saved product' })).toBeVisible();
          assert.deepEqual(commands, ['start', 'get']);
          assert.equal(await count(), originalCount + 1);
        });
        await t.test(
          'two lost replies survive reload and readonly recovery keeps concurrent edits',
          async () => {
            lose = 'both';
            await open();
            await fill(`${engine} uncertain clock`);
            await save();
            await expect(
              page.getByRole('region', { name: 'Product creation recovery' }),
            ).toBeVisible();
            await expect(
              page.getByText('Creation could not be confirmed.', { exact: false }),
            ).toBeVisible();
            assert.equal(await count(), originalCount + 2);
            const created = starts.at(-1);
            assert.ok(created);
            await h.adapter.update('products', created.productId, {
              name: 'Concurrent reviewed edit',
              category: 'untouched-legacy',
            });
            const before = await h.adapter.get('products', created.productId);
            await page.reload();
            await expect(
              page.getByRole('button', { name: 'Check saved product', exact: true }),
            ).toBeVisible();
            lose = 'none';
            const unsavedName = `${engine} new unsaved text after reload`;
            await fill(unsavedName);
            await page.getByRole('button', { name: 'Check saved product', exact: true }).click();
            await expect(
              page.getByRole('button', { name: 'Open saved product', exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole('dialog', { name: 'New Product', exact: true }).locator('#name'),
            ).toHaveValue(unsavedName);
            const downloadPending = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Save current edits', exact: true }).click();
            const downloaded = await downloadPending;
            const draftFile = await downloaded.path();
            assert.ok(draftFile);
            const exported = JSON.parse(await readFile(draftFile, 'utf8'));
            assert.equal(exported.name, unsavedName);
            assert.equal(Object.hasOwn(exported, 'token'), false);
            await expect(
              page.getByText('Opening it replaces the fields in this form.', { exact: false }),
            ).toBeVisible();
            await page.screenshot({
              path: fileURLToPath(
                new URL(
                  `../../../../../output/pricing-clock-repair-2026-10-13/p3e1/create-recovery-${engine}-recovered.png`,
                  import.meta.url,
                ),
              ),
              fullPage: true,
            });
            await page.getByRole('button', { name: 'Open saved product', exact: true }).click();
            await expect(page.locator('[data-saved-product]')).toContainText(
              'Concurrent reviewed edit',
            );
            assert.deepEqual(await h.adapter.get('products', created.productId), before);
            assert.equal(await count(), originalCount + 2);
            assert.equal(starts.length, 2);
          },
        );
        await t.test('session changes cannot dispatch another original creation', async () => {
          lose = 'both';
          await open();
          await fill(`${engine} account bound clock`);
          await save();
          await expect(
            page.getByRole('button', { name: 'Check saved product', exact: true }),
          ).toBeVisible();
          const before = commands.length;
          await page.evaluate(() => {
            localStorage.setItem('channel.token', 'other-token');
            localStorage.setItem('channel.user', JSON.stringify({ id: 'other', role: 'admin' }));
          });
          lose = 'none';
          await page.getByRole('button', { name: 'Check saved product', exact: true }).click();
          await expect(
            page.getByText(
              'Return to the original account and environment to check this creation.',
              { exact: true },
            ),
          ).toBeVisible();
          assert.equal(commands.length, before);
          await page.reload();
          await page.getByRole('button', { name: 'Check saved product', exact: true }).click();
          await expect(
            page.getByRole('button', { name: 'Open saved product', exact: true }),
          ).toBeVisible();
        });
        await page.getByRole('button', { name: 'Open saved product', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Saved product' })).toBeVisible();
        await t.test(
          'the existing Archived choice remains available when creating a private product',
          async () => {
            await open();
            await fill(`${engine} created in archive`);
            await page.getByRole('checkbox', { name: 'Archived', exact: true }).check();
            await save();
            await expect(page.getByRole('heading', { name: 'Saved product' })).toBeVisible();
            const last = starts.at(-1);
            assert.ok(last);
            const product = await h.adapter.get('products', last.productId);
            assert.equal(product?.archived, true);
            assert.equal(product?.published, false);
            assert.equal(await count(), originalCount + 4);
          },
        );
        await t.test(
          'incomplete Published input stays editable and can be saved as a draft',
          async () => {
            await open(true);
            await fill(`${engine} incomplete description`);
            await page.getByRole('checkbox', { name: 'Published', exact: true }).check();
            const createdBefore = starts.length;
            await save();
            await expect(
              page.getByText(
                'Description text or imported description images are required to publish',
                { exact: true },
              ),
            ).toBeVisible();
            assert.equal(starts.length, createdBefore);
            await expect(page.locator('#description')).toBeEnabled();
            await page.getByRole('checkbox', { name: 'Published', exact: true }).uncheck();
            await save();
            await expect(page.getByRole('heading', { name: 'Saved product' })).toBeVisible();
            assert.equal(starts.length, createdBefore + 1);
            assert.equal(
              (await h.adapter.get('products', starts.at(-1)?.productId ?? 'missing'))?.published,
              false,
            );
          },
        );
        await t.test(
          'disabled publication preserves its saved draft and opens Edit without a phantom task',
          async () => {
            await open(true);
            await fill(`${engine} publication unavailable`);
            await page.locator('#description').fill('Reviewed description');
            await page.getByRole('checkbox', { name: 'Published', exact: true }).check();
            const before = publicationCommands.length;
            approvalsEnabled = false;
            try {
              await save();
              await expect(
                page.getByRole('button', { name: 'Open saved product', exact: true }),
              ).toBeEnabled();
              await expect(
                page.getByRole('region', { name: 'Product publication recovery', exact: true }),
              ).toHaveCount(0);
              assert.equal(publicationCommands.length, before);
              assert.equal(
                (await h.adapter.get('products', starts.at(-1)?.productId ?? 'missing'))?.published,
                false,
              );
              await page.getByRole('button', { name: 'Open saved product', exact: true }).click();
              await expect(page.locator('[data-saved-product]')).toContainText(
                `${engine} publication unavailable`,
              );
            } finally {
              approvalsEnabled = true;
            }
          },
        );
        for (const mode of [
          'public',
          'before-start',
          'stop-before-start',
          'stop-before-start-changed',
        ] as const) {
          await t.test(
            `created publication ${mode} recovers after reload using its original task`,
            async () => {
              await open(true);
              const name = `${engine} publication ${mode}`;
              await fill(name);
              await page.locator('#description').fill('Reviewed manual product description');
              await page.getByRole('checkbox', { name: 'Published', exact: true }).check();
              blockPublic = mode === 'public';
              dropPublicationStart = mode !== 'public';
              const startCount = publicationCommands.filter(
                (command) => command.action === 'product-operation-start',
              ).length;
              const createCount = starts.length;
              const continueCount = publicationCommands.filter(
                (command) => command.action === 'product-operation-continue',
              ).length;
              await save();
              await expect(
                page.getByRole('region', { name: 'Product publication recovery', exact: true }),
              ).toBeVisible();
              await expect(
                page.getByRole('button', { name: 'Open saved product', exact: true }),
              ).toBeDisabled();
              const created = starts.at(-1);
              const original = publicationCommands
                .filter((command) => command.action === 'product-operation-start')
                .at(-1);
              assert.ok(created && original);
              if (mode === 'stop-before-start-changed')
                await h.adapter.update('products', created.productId, {
                  name: 'Concurrent product edit preserved',
                });
              assert.equal(
                (await h.adapter.get('products', created.productId))?.published,
                mode === 'public',
                JSON.stringify({
                  failures,
                  alert: await page.getByRole('alert').allTextContents(),
                  recovery: await page
                    .getByRole('region', { name: 'Product publication recovery', exact: true })
                    .innerText(),
                  status: await h.invoke({
                    action: 'product-operation-get',
                    productId: original.productId,
                    operationId: original.operationId,
                  }),
                }),
              );
              await page.reload();
              await page.getByRole('button', { name: 'Check saved product', exact: true }).click();
              await expect(
                page.getByRole('region', { name: 'Product publication recovery', exact: true }),
              ).toContainText(original.operationId);
              await expect(
                page.getByRole('button', { name: 'Open saved product', exact: true }),
              ).toBeDisabled();
              blockPublic = false;
              const action =
                mode === 'public'
                  ? 'Check publication'
                  : mode === 'before-start'
                    ? 'Continue original publication'
                    : 'Stop original publication';
              await page.getByRole('button', { name: action, exact: true }).click();
              await expect(
                page.getByText(
                  mode === 'stop-before-start-changed'
                    ? 'The product changed before the original publication started. That request cannot publish its old version. Review the current product.'
                    : mode === 'stop-before-start'
                      ? 'The original publication is stopped. Review the saved product before editing.'
                      : 'The original publication is confirmed on the website.',
                  { exact: true },
                ),
              ).toBeVisible();
              await expect(
                page.getByRole('button', { name: 'Open saved product', exact: true }),
              ).toBeEnabled();
              assert.equal(
                starts.length,
                createCount + 1,
                'recovery must not create another product',
              );
              const nativeStarts = publicationCommands
                .filter((command) => command.action === 'product-operation-start')
                .slice(startCount);
              assert.equal(nativeStarts.length, mode === 'public' ? 1 : 2);
              assert.equal(
                nativeStarts.every(
                  (command) =>
                    command.operationId === original.operationId &&
                    command.productId === created.productId,
                ),
                true,
              );
              if (mode.startsWith('stop-before-start'))
                assert.equal(
                  publicationCommands.filter(
                    (command) => command.action === 'product-operation-continue',
                  ).length,
                  continueCount,
                );
              await page.screenshot({
                path: fileURLToPath(
                  new URL(
                    `../../../../../output/pricing-clock-repair-2026-10-13/p3e1/created-publication-${engine}-${mode}.png`,
                    import.meta.url,
                  ),
                ),
                fullPage: true,
              });
              await page.getByRole('button', { name: 'Open saved product', exact: true }).click();
              await expect(page.locator('[data-saved-product]')).toContainText(
                mode === 'stop-before-start-changed' ? 'Concurrent product edit preserved' : name,
              );
              const product = await h.adapter.get('products', created.productId);
              assert.ok(product);
              if (product.published === true) {
                assert.ok(
                  product.catalogDetailApprovalReceipt &&
                    typeof product.catalogDetailApprovalReceipt === 'object',
                );
                assert.equal(
                  Reflect.get(product.catalogDetailApprovalReceipt, 'operationId'),
                  original.operationId,
                );
                const withdrawn = await handleAdminRequest(
                  {
                    action: 'update',
                    token,
                    data: {
                      collection: 'products',
                      id: created.productId,
                      expectedUpdatedAt: product.updatedAt,
                      values: { published: false },
                    },
                  },
                  {
                    jwtSecret: 'owned-continue-test-only',
                    enableDetailApproval: true,
                    ...media.config,
                  },
                );
                assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
              } else assert.ok(mode.startsWith('stop-before-start'));
            },
          );
        }
        assert.deepEqual(legacyWrites, []);
        assert.deepEqual(errors, []);
      } finally {
        for (const { productId } of starts) {
          const product = await h.adapter.get('products', productId);
          if (product?.published === true) {
            const receipt = product.catalogDetailApprovalReceipt;
            assert.ok(receipt && typeof receipt === 'object');
            assert.ok(
              publicationCommands.some(
                (command) =>
                  command.productId === productId &&
                  command.operationId === Reflect.get(receipt, 'operationId'),
              ),
            );
            const withdrawn = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id: productId,
                  values: { published: false },
                  expectedUpdatedAt: product.updatedAt,
                },
              },
              {
                jwtSecret: 'owned-continue-test-only',
                enableDetailApproval: true,
                ...media.config,
              },
            );
            assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
          }
          assert.equal((await h.adapter.get('products', productId))?.published, false);
          assert.equal(
            (
              await handlePublicApiEvent(
                { httpMethod: 'GET', path: `/api/products/${productId}/detail` },
                { enableCatalogDetail: true },
              )
            ).statusCode,
            404,
          );
        }
        await page.unrouteAll({ behavior: 'wait' });
      }
    },
  );

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
    `${engine} actual table publishes, checks original tasks and restores selected products`,
    { timeout: 150000 },
    async (t) => {
      const h = await workspace(t, 0, true);
      const media = await coldOwnedMedia(h);
      const directory = await mkdtemp(join(tmpdir(), 'channel-table-publication-ui-'));
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const { chromium, webkit, expect } = await import('@playwright/test');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(directory, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/testing/table-publication-browser-harness.tsx'],
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            '@tanstack/react-query',
            '@tanstack/react-table',
            'zod',
          ],
        },
        plugins: [
          tailwind(),
          {
            name: 'table-publication-fixture',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                if (request.url?.startsWith('/table-publication')) {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(
                    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main id="table-publication-root"></main><script type="module" src="/src/islands/admin/testing/table-publication-browser-harness.tsx"></script></body></html>',
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
      page.setDefaultTimeout(12000);
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
          JSON.stringify({ id: 'admin', role: 'admin', name: 'Admin' }),
        );
      }, token);
      const selected = Array.from(
        { length: 20 },
        (_, index) => `table-ui-${String(index).padStart(2, '0')}`,
      );
      for (const [index, id] of selected.entries())
        await h.adapter.create('products', {
          _id: id,
          name: `Table UI item ${String(index).padStart(2, '0')}`,
          description: 'Reviewed table item description',
          productFamily: 'misc',
          imageIds: ['image'],
          published: false,
          archived: false,
          unitPrice: 5.7,
          moq: 1,
        });
      const config = {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
        ...media.config,
      };
      const commands: { action: string; productId: string; operationId: string }[] = [];
      const legacy: string[] = [];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let blockPublic = false;
      let dropStart = false;
      let publicGate: Promise<void> | undefined;
      let releasePublic = () => {};
      let publicEntered = () => {};
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, new URL(origin).origin);
        if (url.pathname === '/api/admin') {
          const body = route.request().postDataJSON();
          if (String(body.data?.action).startsWith('product-operation-'))
            commands.push(structuredClone(body.data));
          if (
            body.action === 'update' ||
            (body.action === 'catalogDetailApproval' &&
              !String(body.data?.action).startsWith('product-operation-'))
          )
            legacy.push(body.action);
          if (dropStart && body.data?.action === 'product-operation-start') {
            dropStart = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: await handleAdminRequest(body, config) });
        } else {
          assert.equal(route.request().method(), 'GET');
          if (publicGate && url.pathname.endsWith('/detail')) {
            publicEntered();
            await publicGate;
          }
          if (blockPublic && url.pathname.endsWith('/detail')) {
            await route.abort('failed');
            return;
          }
          const response = await handlePublicApiEvent(
            {
              httpMethod: 'GET',
              path: url.pathname,
              queryStringParameters: Object.fromEntries(url.searchParams),
            },
            { enableCatalogDetail: true },
          );
          await route.fulfill({
            status: response.statusCode,
            headers: response.headers,
            body:
              'isBase64Encoded' in response && response.isBase64Encoded
                ? Buffer.from(response.body, 'base64')
                : response.body,
          });
        }
      });
      const open = async () => {
        await page.goto(`${origin}table-publication?productFamily=misc`);
        await expect(page.getByRole('row').filter({ hasText: 'Table UI item' })).toHaveCount(20);
      };
      const row = () => page.getByRole('row').filter({ hasText: 'Table UI item 00' });
      const bulk = async (name: 'Publish' | 'Disable') => {
        const bar = page
          .getByRole('button', { name: 'Assign category', exact: true })
          .locator('..');
        if (engine === 'webkit') await bar.locator('summary').click();
        await bar.getByRole('button', { name, exact: true }).click();
      };
      const starts = () =>
        commands.filter((command) => command.action === 'product-operation-start');
      const writes = () => commands.filter((command) => command.action !== 'product-operation-get');
      try {
        await t.test(
          'a row publish uses one original task; Disable remains guarded and hides its website detail',
          async () => {
            await open();
            await row().getByRole('button', { name: 'Disabled', exact: true }).click();
            await expect(
              row().getByRole('button', { name: 'Published', exact: true }),
            ).toBeVisible();
            assert.equal(starts().length, 1);
            assert.deepEqual(legacy, []);
            const current = await h.adapter.get('products', selected[0] ?? '');
            assert.equal(current?.published, true);
            assert.equal(current?.productFamily, 'misc');
            assert.equal(current?.unitPrice, 5.7);
            await row().getByRole('button', { name: 'Published', exact: true }).click();
            await expect(
              row().getByRole('button', { name: 'Disabled', exact: true }),
            ).toBeVisible();
            assert.deepEqual(legacy, ['update']);
            assert.equal(
              (
                await handlePublicApiEvent(
                  { httpMethod: 'GET', path: `/api/products/${selected[0]}/detail` },
                  { enableCatalogDetail: true },
                )
              ).statusCode,
              404,
            );
          },
        );
        await t.test(
          '20 unconfirmed publications survive reload; Stop does not undo committed work; Check is readonly',
          async () => {
            await open();
            blockPublic = true;
            await page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
            await bulk('Publish');
            await expect(
              page.getByText("0 published · 20 couldn't be checked", { exact: true }),
            ).toBeVisible({ timeout: 30000 });
            let inbox = page.getByRole('region', { name: 'Publication recovery', exact: true });
            await expect(
              inbox.getByText('Original publication tasks (20)', { exact: true }),
            ).toBeVisible();
            assert.equal(starts().length, 21);
            for (const id of selected)
              assert.equal((await h.adapter.get('products', id))?.published, true);
            const before = writes().length;
            await inbox
              .getByRole('button', { name: 'Stop original publications', exact: true })
              .click();
            await expect(
              inbox.getByRole('button', { name: 'Stop original publications', exact: true }),
            ).toBeEnabled();
            assert.equal(
              writes().length,
              before,
              'stopping an already complete publication only checks its original result',
            );
            for (const id of selected)
              assert.equal((await h.adapter.get('products', id))?.published, true);
            await page.reload();
            inbox = page.getByRole('region', { name: 'Publication recovery', exact: true });
            await expect(
              inbox.getByText('Original publication tasks (20)', { exact: true }),
            ).toBeVisible();
            const taskDetails = inbox.locator('details');
            await expect(taskDetails).not.toHaveAttribute('open');
            const box = await inbox.boundingBox();
            assert.ok(
              box && box.height < 650,
              '20 original tasks must not bury the table below a long expanded card list',
            );
            await taskDetails.locator('summary').click();
            await expect(inbox.getByRole('button', { name: /^Check original task / })).toHaveCount(
              20,
            );
            await taskDetails.locator('summary').click();
            await page.screenshot({
              path: fileURLToPath(
                new URL(
                  `../../../../../output/pricing-clock-repair-2026-10-13/p3e1/table-publication-${engine}-recovery.png`,
                  import.meta.url,
                ),
              ),
              fullPage: true,
            });
            blockPublic = false;
            await inbox
              .getByRole('button', { name: 'Check original publications', exact: true })
              .click();
            await expect(
              inbox.getByText(
                '20 original publications confirmed on the website. Stopping does not withdraw a publication that already completed.',
                { exact: true },
              ),
            ).toBeVisible();
            assert.equal(writes().length, before);
            assert.equal(starts().length, 21);
            await page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
            await bulk('Publish');
            await expect(
              page.getByText('0 published · 20 already enabled (unchanged)', { exact: true }),
            ).toBeVisible({ timeout: 30000 });
            assert.equal(starts().length, 21, 'an unchanged publication creates no new operation');
            await expect(
              page.getByRole('checkbox', { name: 'Select all rows', exact: true }),
            ).not.toBeChecked();
            await page.getByRole('checkbox', { name: 'Select all rows', exact: true }).check();
            await bulk('Disable');
            await expect(page.getByText('20 disabled', { exact: true })).toBeVisible();
            for (const id of selected)
              assert.equal((await h.adapter.get('products', id))?.published, false);
            assert.equal(legacy.filter((action) => action !== 'update').length, 0);
          },
        );
        await t.test(
          'a row task that never reached the server can be stopped after reload without changing the product',
          async () => {
            await open();
            const before = await h.adapter.get('products', selected[0] ?? '');
            const count = starts().length;
            const continued = commands.filter(
              (command) => command.action === 'product-operation-continue',
            ).length;
            dropStart = true;
            await row().getByRole('button', { name: 'Disabled', exact: true }).click();
            await expect(
              page.getByRole('region', { name: 'Publication recovery', exact: true }),
            ).toBeVisible();
            const original = starts().at(-1);
            assert.ok(original);
            await page.reload();
            const inbox = page.getByRole('region', { name: 'Publication recovery', exact: true });
            await expect(inbox).toContainText(original.operationId);
            await inbox
              .getByRole('button', { name: 'Stop original publications', exact: true })
              .click();
            await expect(inbox).toContainText('Publication stopped. Saved draft changes remain.');
            assert.equal(starts().length, count + 2);
            assert.equal(starts().at(-1)?.operationId, original.operationId);
            assert.equal(
              commands.filter((command) => command.action === 'product-operation-continue').length,
              continued,
            );
            assert.deepEqual(await h.adapter.get('products', selected[0] ?? ''), before);
          },
        );
        await t.test(
          'same-tab Check replaces an unconfirmed row result and account changes hide another owner’s feedback',
          async () => {
            await open();
            blockPublic = true;
            await row().getByRole('button', { name: 'Disabled', exact: true }).click();
            await expect(
              page.getByText("0 published · 1 couldn't be checked", { exact: true }),
            ).toBeVisible();
            await h.adapter.create('users', {
              _id: 'other-admin',
              role: 'admin',
              status: 'active',
            });
            const otherToken = await signSession('owned-continue-test-only', {
              sub: 'other-admin',
              role: 'admin',
              name: 'Other Admin',
              email: 'other@example.test',
            });
            const switchAccount = async (actor: string, currentToken: string) => {
              await page.evaluate(
                ({ actor, currentToken }) => {
                  localStorage.setItem('channel.token', currentToken);
                  localStorage.setItem(
                    'channel.user',
                    JSON.stringify({ id: actor, role: 'admin', name: actor }),
                  );
                  window.dispatchEvent(new Event('channel:auth'));
                },
                { actor, currentToken },
              );
            };
            await switchAccount('other-admin', otherToken);
            await expect(
              page.getByRole('region', { name: 'Publication recovery', exact: true }),
            ).toBeHidden();
            await expect(
              page.getByText("0 published · 1 couldn't be checked", { exact: true }),
            ).toBeHidden();
            await switchAccount('admin', token);
            const inbox = page.getByRole('region', { name: 'Publication recovery', exact: true });
            await expect(inbox).toContainText('Original publication tasks (1)');
            blockPublic = false;
            await inbox
              .getByRole('button', { name: 'Check original publications', exact: true })
              .click();
            await expect(inbox).toContainText('1 original publication confirmed on the website.');
            await expect(
              page.getByText("0 published · 1 couldn't be checked", { exact: true }),
            ).toBeHidden();
            await row().getByRole('button', { name: 'Published', exact: true }).click();
            await expect(
              row().getByRole('button', { name: 'Disabled', exact: true }),
            ).toBeVisible();
            // A late result belonging to the first session cannot populate the second session.
            const entered = new Promise<void>((resolve) => {
              publicEntered = resolve;
            });
            publicGate = new Promise<void>((resolve) => {
              releasePublic = resolve;
            });
            await row().getByRole('button', { name: 'Disabled', exact: true }).click();
            await entered;
            await switchAccount('other-admin', otherToken);
            releasePublic();
            publicGate = undefined;
            await expect(
              page.getByRole('region', { name: 'Publication recovery', exact: true }),
            ).toBeHidden();
            await expect(
              page.getByText(/Return to the original account and API environment/),
            ).toBeHidden();
            await switchAccount('admin', token);
            await expect(inbox).toContainText('Original publication tasks (1)');
            await inbox
              .getByRole('button', { name: 'Check original publications', exact: true })
              .click();
            await expect(inbox).toContainText('1 original publication confirmed on the website.');
            await row().getByRole('button', { name: 'Published', exact: true }).click();
            await expect(
              row().getByRole('button', { name: 'Disabled', exact: true }),
            ).toBeVisible();
          },
        );

        await t.test(
          'a private editor request missing on the server can be stopped after reload without restoring its body',
          async () => {
            await open();
            const id = selected[0];
            assert.ok(id);
            const before = await h.adapter.get('products', id);
            assert.ok(before);
            const count = starts().length;
            const continued = commands.filter(
              (command) => command.action === 'product-operation-continue',
            ).length;
            dropStart = true;
            const state = await page.evaluate(
              async ({ id, updatedAt }) => {
                const api = await import(
                  new URL('/src/islands/admin/catalog-product-operation-api.ts', location.href).href
                );
                const runner = await import(
                  new URL('/src/islands/admin/catalog-publication-batch.ts', location.href).href
                );
                const batch = runner.createPublicationBatch();
                const result = await batch.run([
                  api.createPublicationAttempt({
                    productId: id,
                    expectedUpdatedAt: updatedAt,
                    values: {
                      description: 'Private editor text must never enter recovery storage',
                    },
                  }),
                ]);
                return result.items[0]?.state;
              },
              { id, updatedAt: before.updatedAt ?? null },
            );
            assert.equal(state, 'unknown');
            const original = starts().at(-1);
            assert.ok(original);
            assert.equal(
              await page.evaluate(() =>
                Object.values(localStorage).some((value) =>
                  String(value).includes('Private editor text must never enter recovery storage'),
                ),
              ),
              false,
            );
            await page.reload();
            const inbox = page.getByRole('region', { name: 'Publication recovery', exact: true });
            await expect(inbox).toContainText('Original publication tasks (1)');
            await inbox
              .getByRole('button', { name: 'Stop original publications', exact: true })
              .click();
            await expect(inbox).toContainText('Publication stopped. Saved draft changes remain.');
            assert.equal(starts().length, count + 1, 'only the original failed start was sent');
            assert.equal(
              commands.filter((command) => command.action === 'product-operation-continue').length,
              continued,
            );
            assert.equal(
              commands.filter(
                (command) =>
                  command.action === 'product-operation-stop' &&
                  command.operationId === original.operationId,
              ).length,
              1,
            );
            assert.deepEqual(await h.adapter.get('products', id), before);
          },
        );
        assert.deepEqual(errors, []);
      } finally {
        releasePublic();
        publicGate = undefined;
        blockPublic = false;
        dropStart = false;
        await page.unrouteAll({ behavior: 'wait' });
        for (const id of selected) {
          const current = await h.adapter.get('products', id);
          assert.ok(current);
          if (current.published === true) {
            const response = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id,
                  expectedUpdatedAt: current.updatedAt,
                  values: { published: false },
                },
              },
              config,
            );
            assert.ok(response.ok, JSON.stringify(response));
          }
          assert.equal(
            (
              await handlePublicApiEvent(
                { httpMethod: 'GET', path: `/api/products/${id}/detail` },
                { enableCatalogDetail: true },
              )
            ).statusCode,
            404,
          );
        }
      }
    },
  );

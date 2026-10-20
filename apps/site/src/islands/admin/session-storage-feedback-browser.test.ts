import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { parseDocument } from 'yaml';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { workspace } from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
function deferred() {
  let done = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done: () => done() };
}
for (const engine of ['chromium', 'webkit'] as const)
  test(
    `${engine} actual session components recover storage failures and reject stale account responses`,
    { timeout: 120000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'channel-session-feedback-'));
      let captureIndex = 0;
      const capture = async (page: Page) => {
        if (process.env.SESSION_FEEDBACK_EVIDENCE !== '1') return;
        const evidence = fileURLToPath(
          new URL(
            '../../../../../output/pricing-clock-repair-2026-10-13/p3e1/admin-session-recovery-ui/',
            import.meta.url,
          ),
        );
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${engine}-${++captureIndex}.png`) });
      };
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const { chromium, webkit, expect } = await import('@playwright/test');
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        cacheDir: join(directory, 'vite'),
        optimizeDeps: {
          entries: ['src/islands/admin/testing/session-feedback-browser-harness.tsx'],
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
          {
            name: 'session-real-i18n-frontmatter',
            enforce: 'pre',
            transform(source, id) {
              if (!id.endsWith('.md') || !id.includes('/src/i18n/content/')) return;
              const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
              if (!match?.[1]) throw Error('Missing actual i18n frontmatter');
              const document = parseDocument(match[1], { uniqueKeys: true });
              if (document.errors.length) throw Error('Invalid actual i18n');
              return {
                code: `export const frontmatter=${JSON.stringify(document.toJSON())};`,
                map: null,
              };
            },
          },
          tailwind(),
          {
            name: 'session-feedback-fixture',
            configureServer(server) {
              server.middlewares.use((request, response, next) => {
                const path = new URL(request.url ?? '/', 'http://fixture').pathname;
                if (path === '/session-feedback-test') {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(
                    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="session-feedback-root"></div><script type="module" src="/src/islands/admin/testing/session-feedback-browser-harness.tsx"></script></body></html>',
                  );
                } else if (['/', '/login', '/admin'].includes(path)) {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(`<h1>Destination ${path}</h1>`);
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
      await t.test(
        'blocked admin storage has a retryable error and recovers to login',
        async (child) => {
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          child.after(() => context.close());
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          let api = 0;
          await page.route('**/api/admin', async (route) => {
            api++;
            await route.fulfill({
              status: 401,
              json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'No session' } },
            });
          });
          await page.addInitScript(() => {
            if (location.pathname !== '/session-feedback-test') return;
            const before = Object.getOwnPropertyDescriptor(window, 'localStorage');
            Reflect.set(window, '__restoreSessionStorage', () => {
              if (before) Object.defineProperty(window, 'localStorage', before);
              else Reflect.deleteProperty(window, 'localStorage');
            });
            Object.defineProperty(window, 'localStorage', {
              configurable: true,
              get() {
                throw new DOMException('Denied', 'SecurityError');
              },
            });
          });
          await page.goto(new URL('session-feedback-test', origin).href);
          await expect(page.getByRole('heading', { name: 'Session check failed' })).toBeVisible();
          await expect(page.getByText(/site storage/)).toBeVisible();
          await capture(page);
          assert.equal(api, 0);
          assert.deepEqual(errors, []);
          await page.evaluate(() => {
            const restore = Reflect.get(window, '__restoreSessionStorage');
            if (typeof restore !== 'function') throw Error('Missing restore');
            restore();
          });
          const retry = page.getByRole('button', { name: 'Try signing out again' });
          await expect(retry).toBeVisible();
          await retry.click();
          await expect(page.getByRole('heading', { name: 'Destination /login' })).toBeVisible();
          assert.deepEqual(errors, []);
        },
      );
      await t.test(
        'an expired background read keeps the open form and offers account recovery',
        async (child) => {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            acceptDownloads: true,
          });
          child.after(() => context.close());
          const page = await context.newPage();
          const pendingRead = deferred();
          child.after(async () => pendingRead.done());
          let held = false;
          const requests: string[] = [];
          await page.addInitScript(() => {
            localStorage.setItem('channel.token', 'admin-token');
            localStorage.setItem(
              'channel.user',
              JSON.stringify({
                id: 'admin',
                username: 'Admin',
                email: 'fixture@example.test',
                role: 'admin',
              }),
            );
          });
          await page.route('**/api/admin', async (route) => {
            const body = route.request().postDataJSON();
            requests.push(body.action);
            if (body.action === 'me') {
              await route.fulfill({
                json: {
                  ok: true,
                  data: {
                    user: {
                      id: 'admin',
                      username: 'Admin',
                      email: 'fixture@example.test',
                      role: 'admin',
                    },
                  },
                },
              });
            } else if (body.action === 'inquiryCapabilities') {
              await route.fulfill({
                json: { ok: true, data: { enabled: false, notification: 'disabled' } },
              });
            } else if (body.action === 'list') {
              if (!held) {
                held = true;
                await pendingRead.promise;
                await route.fulfill({
                  status: 401,
                  json: {
                    ok: false,
                    error: { code: 'UNAUTHORIZED', message: 'Owned expired background session' },
                  },
                });
              } else
                await route.fulfill({
                  json: { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } },
                });
            } else throw Error(`Unexpected owned session action: ${body.action}`);
          });
          await page.goto(new URL('session-feedback-test', origin).href);
          await page.getByRole('button', { name: 'New User', exact: true }).click();
          const form = page.getByRole('dialog', { name: 'New User', exact: true });
          await form.locator('#email').fill('private-unsaved@example.test');
          assert.equal(held, true);
          pendingRead.done();
          const recovery = page.getByRole('dialog', {
            name: 'Reconnect your account',
            exact: true,
          });
          await expect(recovery).toBeVisible();
          await capture(page);
          assert.equal(new URL(page.url()).pathname, '/session-feedback-test');
          await expect(form.locator('#email')).toHaveValue('private-unsaved@example.test');
          assert.equal(requests.includes('create'), false);
          await page.keyboard.press('Escape');
          await expect(recovery).toBeVisible();
          const modulePath = '/src/islands/admin/testing/session-feedback-browser-harness.tsx';
          const beforeWrite = requests.length;
          assert.equal(
            await page.evaluate(
              async (path) => (await import(path)).tryPausedRecordWrite(),
              modulePath,
            ),
            'SESSION_PAUSED',
          );
          assert.equal(requests.length, beforeWrite);
          await recovery.getByRole('button', { name: 'Leave this workspace', exact: true }).click();
          await expect(recovery.getByRole('alert')).toContainText('Download your current edits');
          const downloadEvent = page.waitForEvent('download');
          await recovery
            .getByRole('button', { name: 'Download current edits', exact: true })
            .click();
          const downloadPath = await (await downloadEvent).path();
          assert.ok(downloadPath);
          const exported = await readFile(downloadPath, 'utf8');
          assert.equal(JSON.parse(exported)[0].values.email, 'private-unsaved@example.test');
          assert.doesNotMatch(exported, /admin-token|channel.token/);
          const changeSession = async (token: string, id: string) =>
            page.evaluate(
              async ({ path, token, id }) => (await import(path)).replaceTestSession(token, id),
              { path: modulePath, token, id },
            );
          await changeSession('other-token', 'other');
          const beforeWrongAccount = requests.length;
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery.getByRole('alert')).toContainText('original account');
          assert.equal(requests.length, beforeWrongAccount);
          // Reusing a still-valid original token must not revive its cached 401.
          await changeSession('admin-token', 'admin');
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery).toHaveCount(0);
          await expect
            .poll(() => requests.filter((action) => action === 'list').length)
            .toBeGreaterThan(1);
          await expect(recovery).toHaveCount(0);
          await expect(form.locator('#email')).toHaveValue('private-unsaved@example.test');
          await form.locator('#email').fill('still-editable@example.test');
          assert.equal(requests.includes('create') || requests.includes('update'), false);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
        },
      );
      await t.test(
        'renewed original account keeps real creation and edit forms and saves the original private draft',
        async (child) => {
          const h = await workspace(child);
          await h.adapter.update('users', 'admin', {
            username: 'Admin',
            email: 'admin@example.test',
          });
          const config = { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true };
          const token = await signSession(config.jwtSecret, {
            sub: 'admin',
            role: 'admin',
            name: 'Admin',
            email: 'admin@example.test',
          });
          const renewed = await signSession(config.jwtSecret, {
            sub: 'admin',
            role: 'admin',
            name: 'Renewed Admin',
            email: 'admin@example.test',
          });
          assert.notEqual(token, renewed);
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          child.after(() => context.close());
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const pendingRead = deferred();
          child.after(async () => pendingRead.done());
          let held = false;
          let holdCreatedReply = false;
          const createdReply = deferred();
          const createCommitted = deferred();
          child.after(() => createdReply.done());
          const requests: { action: string; operation?: string }[] = [];
          await page.addInitScript(
            ({ token }) => {
              localStorage.setItem('channel.token', token);
              localStorage.setItem(
                'channel.user',
                JSON.stringify({
                  id: 'admin',
                  username: 'Admin',
                  email: 'admin@example.test',
                  role: 'admin',
                }),
              );
            },
            { token },
          );
          await page.route('**/api/admin', async (route) => {
            const body = route.request().postDataJSON();
            requests.push({ action: body.action, operation: body.data?.action });
            if (
              body.action === 'list' &&
              body.data.collection === 'products' &&
              body.data.pageSize === 20 &&
              !held
            ) {
              held = true;
              await pendingRead.promise;
              await route.fulfill({
                status: 401,
                json: {
                  ok: false,
                  error: { code: 'UNAUTHORIZED', message: 'Owned expired list response' },
                },
              });
              return;
            }
            const result = await handleAdminRequest(body, config);
            if (
              holdCreatedReply &&
              body.action === 'catalogProductCreate' &&
              body.data.action === 'start'
            ) {
              assert.equal(result.ok, true);
              createCommitted.done();
              await createdReply.promise;
            }
            await route.fulfill({
              status: result.ok ? 200 : result.error.code === 'UNAUTHORIZED' ? 401 : 400,
              json: result,
            });
          });
          await page.goto(new URL('session-feedback-test', origin).href);
          await page.getByRole('button', { name: 'Products', exact: true }).click();
          await page.getByRole('button', { name: 'New Product', exact: true }).click();
          const form = page.getByRole('dialog', { name: 'New Product', exact: true });
          const name = `Owned resumed draft ${engine}`;
          await form.locator('#name').fill(name);
          await form
            .locator('#description')
            .fill('Private edits must survive account verification.');
          await page.setViewportSize({ width: 390, height: 844 });
          assert.equal(held, true);
          pendingRead.done();
          const recovery = page.getByRole('dialog', {
            name: 'Reconnect your account',
            exact: true,
          });
          await expect(recovery).toBeVisible();
          await page.evaluate(
            async ({ path, token }) => (await import(path)).replaceTestSession(token, 'admin'),
            {
              path: '/src/islands/admin/testing/session-feedback-browser-harness.tsx',
              token: renewed,
            },
          );
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery).toHaveCount(0);
          await expect(form.locator('#name')).toHaveValue(name);
          await expect(form.locator('#description')).toHaveValue(
            'Private edits must survive account verification.',
          );
          assert.equal(
            requests.some((request) => request.action === 'catalogProductCreate'),
            false,
          );
          await form.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(form).toHaveCount(0);
          const products = await h.adapter.list({
            collection: 'products',
            page: 1,
            pageSize: 20,
            search: '',
          });
          const created = products.items.filter((product) => product.name === name);
          assert.equal(created.length, 1);
          assert.equal(created[0]?.published, false);
          assert.equal(
            created[0]?.productFamily,
            undefined,
            'No category is invented for a new draft.',
          );
          assert.equal(
            requests.filter(
              (request) =>
                request.action === 'catalogProductCreate' && request.operation === 'start',
            ).length,
            1,
          );
          assert.equal(
            requests.some((request) => request.action === 'create'),
            false,
          );
          // The created product enters the actual editor, whose controller must also rebind.
          const row = page.getByRole('row').filter({ hasText: name });
          await row.getByRole('button', { name: 'Edit', exact: true }).click();
          const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
          await editor.locator('#name').fill(`${name} edited`);
          await page.evaluate(
            async ({ path, token }) => (await import(path)).replaceTestSession(token, 'admin'),
            {
              path: '/src/islands/admin/testing/session-feedback-browser-harness.tsx',
              token,
            },
          );
          await expect(recovery).toBeVisible();
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery).toHaveCount(0);
          await expect(editor.locator('#name')).toHaveValue(`${name} edited`);
          await editor.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(editor).toHaveCount(0);
          assert.equal(
            (await h.adapter.get('products', String(created[0]?._id)))?.name,
            `${name} edited`,
          );
          assert.equal(
            requests.some((request) => request.action === 'update'),
            false,
          );
          assert.equal(
            requests.filter(
              (request) =>
                request.action === 'catalogDetailApproval' &&
                request.operation === 'product-operation-start',
            ).length,
            1,
          );
          // A committed creation whose response arrives after expiry retains its original receipt.
          holdCreatedReply = true;
          await page.getByRole('button', { name: 'New Product', exact: true }).click();
          const interrupted = page.getByRole('dialog', { name: 'New Product', exact: true });
          const interruptedName = `Owned uncertain creation ${engine}`;
          await interrupted.locator('#name').fill(interruptedName);
          await interrupted.getByRole('button', { name: 'Save', exact: true }).click();
          await createCommitted.promise;
          await page.evaluate(
            async ({ path, token }) => (await import(path)).replaceTestSession(token, 'admin'),
            {
              path: '/src/islands/admin/testing/session-feedback-browser-harness.tsx',
              token: renewed,
            },
          );
          await expect(recovery).toBeVisible();
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery.getByRole('alert')).toContainText('original creation check');
          createdReply.done();
          await expect(
            interrupted.getByRole('button', { name: 'Save', exact: true }),
          ).toBeEnabled();
          await recovery
            .getByRole('button', { name: 'Verify original account', exact: true })
            .click();
          await expect(recovery)
            .toHaveCount(0)
            .catch(async (cause) => {
              child.diagnostic(await recovery.innerText());
              throw cause;
            });
          await expect(interrupted.locator('#name')).toHaveValue(interruptedName);
          await interrupted
            .getByRole('button', { name: 'Check saved product', exact: true })
            .click();
          await expect(
            interrupted.getByText(
              'The original product is saved. Checking creation only reads its saved state.',
              { exact: true },
            ),
          ).toBeVisible();
          const finalProducts = await h.adapter.list({
            collection: 'products',
            page: 1,
            pageSize: 20,
            search: '',
          });
          assert.equal(
            finalProducts.items.filter((product) => product.name === interruptedName).length,
            1,
          );
          assert.equal(
            requests.filter(
              (request) =>
                request.action === 'catalogProductCreate' && request.operation === 'start',
            ).length,
            2,
          );
          assert.deepEqual(errors, []);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
        },
      );
      for (const partial of [false, true])
        await t.test(`authorized admin sign out partial=${partial} retries home`, async (child) => {
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          child.after(() => context.close());
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.addInitScript(() => {
            if (location.pathname !== '/session-feedback-test') return;
            localStorage.setItem('channel.token', 'admin-token');
            localStorage.setItem(
              'channel.user',
              JSON.stringify({
                id: 'admin',
                username: 'Admin',
                email: 'fixture@example.test',
                role: 'admin',
              }),
            );
          });
          await page.route('**/api/admin', async (route) => {
            const request: unknown = route.request().postDataJSON();
            assert.ok(request && typeof request === 'object');
            const action = Reflect.get(request, 'action');
            if (action === 'me') {
              await route.fulfill({
                json: {
                  ok: true,
                  data: {
                    user: {
                      id: 'admin',
                      username: 'Admin',
                      email: 'fixture@example.test',
                      role: 'admin',
                    },
                  },
                },
              });
              return;
            }
            if (action === 'inquiryCapabilities') {
              await route.fulfill({
                json: { ok: true, data: { enabled: false, notification: 'disabled' } },
              });
              return;
            }
            if (action === 'list') {
              const data = Reflect.get(request, 'data');
              assert.ok(data && typeof data === 'object');
              await route.fulfill({
                json: {
                  ok: true,
                  data: {
                    items: [],
                    total: 0,
                    page: Reflect.get(data, 'page') ?? 1,
                    pageSize: Reflect.get(data, 'pageSize') ?? 20,
                  },
                },
              });
              return;
            }
            throw Error('Unexpected session fixture action');
          });
          await page.goto(new URL('session-feedback-test', origin).href);
          await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
          await page.evaluate((partial) => {
            const remove = Storage.prototype.removeItem;
            Reflect.set(window, '__restoreAdminRemove', () => {
              Storage.prototype.removeItem = remove;
            });
            Storage.prototype.removeItem = function (key) {
              if (!partial || key === 'channel.user')
                throw new DOMException('Denied', 'SecurityError');
              remove.call(this, key);
            };
          }, partial);
          await page.getByRole('button', { name: 'Sign out', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Session check failed' })).toBeVisible();
          await expect(page.getByText(/site storage/)).toBeVisible();
          await capture(page);
          assert.deepEqual(errors, []);
          await page.evaluate(() => {
            const restore = Reflect.get(window, '__restoreAdminRemove');
            if (typeof restore !== 'function') throw Error('Missing restore');
            restore();
          });
          const retry = page.getByRole('button', { name: 'Try signing out again' });
          await expect(retry).toBeVisible();
          await retry.click();
          await expect(
            page.getByRole('heading', { name: 'Destination /', exact: true }),
          ).toBeVisible();
          assert.deepEqual(
            await page.evaluate(() => [
              localStorage.getItem('channel.token'),
              localStorage.getItem('channel.user'),
            ]),
            [null, null],
          );
          assert.deepEqual(errors, []);
        });
      for (const layout of ['navigation', 'dropdown'] as const)
        for (const partial of [false, true])
          await t.test(
            `${layout} sign out partial=${partial} reports storage failure and retries its original destination`,
            async (child) => {
              const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
              child.after(() => context.close());
              const page = await context.newPage();
              const errors: string[] = [];
              page.on('pageerror', (error) => errors.push(error.message));
              await page.addInitScript(() => {
                if (location.pathname !== '/session-feedback-test') return;
                localStorage.setItem('channel.token', 'fixture-token');
                localStorage.setItem(
                  'channel.user',
                  JSON.stringify({
                    id: 'admin',
                    username: 'Fixture Admin',
                    email: 'fixture@example.test',
                    role: 'admin',
                  }),
                );
              });
              await page.goto(new URL(`session-feedback-test?view=account-${layout}`, origin).href);
              if (layout === 'dropdown') await page.locator('[data-account-trigger]').click();
              await expect(
                page.getByRole('button', { name: 'Sign out', exact: true }),
              ).toBeVisible();
              await page.evaluate((partial) => {
                const remove = Storage.prototype.removeItem;
                Reflect.set(window, '__restoreSessionRemove', () => {
                  Storage.prototype.removeItem = remove;
                });
                Storage.prototype.removeItem = function (key) {
                  if (!partial || key === 'channel.user')
                    throw new DOMException('Denied', 'SecurityError');
                  remove.call(this, key);
                };
              }, partial);
              await page.getByRole('button', { name: 'Sign out', exact: true }).click();
              await expect(page.getByText(/site storage/)).toBeVisible();
              await capture(page);
              assert.deepEqual(errors, []);
              assert.ok(page.url().includes('session-feedback-test'));
              await page.evaluate(() => {
                const restore = Reflect.get(window, '__restoreSessionRemove');
                if (typeof restore !== 'function') throw Error('Missing restore');
                restore();
              });
              const retry = page.getByRole('button', {
                name: partial ? 'Retry sign out' : 'Sign out',
                exact: true,
              });
              await expect(retry).toBeVisible();
              await retry.click();
              await expect(
                page.getByRole('heading', { name: 'Destination /', exact: true }),
              ).toBeVisible();
              assert.deepEqual(
                await page.evaluate(() => [
                  localStorage.getItem('channel.token'),
                  localStorage.getItem('channel.user'),
                ]),
                [null, null],
              );
              assert.deepEqual(errors, []);
            },
          );
      await t.test(
        'login storage write failure remains on the form and retries after storage recovery',
        async (child) => {
          const context = await browser.newContext();
          child.after(() => context.close());
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          let logins = 0;
          await page.route('**/api/admin', async (route) => {
            logins++;
            await route.fulfill({
              json: {
                ok: true,
                data: {
                  token: 'fixture-token',
                  user: {
                    id: 'admin',
                    username: 'Fixture Admin',
                    email: 'fixture@example.test',
                    role: 'admin',
                  },
                },
              },
            });
          });
          await page.goto(new URL('session-feedback-test?view=login', origin).href);
          await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
          await page.getByLabel('Email', { exact: true }).fill('fixture@example.test');
          await page.getByLabel('Password', { exact: true }).fill('synthetic-password-only');
          await page.evaluate(() => {
            const set = Storage.prototype.setItem;
            Reflect.set(window, '__restoreSessionWrite', () => {
              Storage.prototype.setItem = set;
            });
            Storage.prototype.setItem = () => {
              throw new DOMException('Full', 'QuotaExceededError');
            };
          });
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await expect(page.getByText(/site storage/)).toBeVisible();
          await capture(page);
          assert.ok(page.url().includes('session-feedback-test'));
          assert.equal(logins, 1);
          assert.deepEqual(errors, []);
          await page.evaluate(() => {
            const restore = Reflect.get(window, '__restoreSessionWrite');
            if (typeof restore !== 'function') throw Error('Missing restore');
            restore();
          });
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Destination /admin' })).toBeVisible();
          assert.equal(logins, 2);
          assert.equal(
            await page.evaluate(() => localStorage.getItem('channel.token')),
            'fixture-token',
          );
          assert.deepEqual(errors, []);
        },
      );
      for (const oldResponse of ['success', 'unauthorized'] as const)
        await t.test(
          `a held old me ${oldResponse} reply cannot overwrite the new token and account`,
          async (child) => {
            const context = await browser.newContext();
            child.after(() => context.close());
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const held = deferred();
            const release = deferred();
            let bRequests = 0;
            await page.addInitScript(() => {
              if (location.pathname !== '/session-feedback-test') return;
              localStorage.setItem('channel.token', 'token-a');
              localStorage.setItem(
                'channel.user',
                JSON.stringify({ id: 'a', username: 'A', email: 'a@example.test', role: 'member' }),
              );
            });
            await page.route('**/api/admin', async (route) => {
              const request: unknown = route.request().postDataJSON();
              assert.ok(request && typeof request === 'object');
              assert.equal(Reflect.get(request, 'action'), 'me');
              const token = Reflect.get(request, 'token');
              if (token === 'token-a') {
                held.done();
                await release.promise;
              } else {
                assert.equal(token, 'token-b');
                bRequests++;
              }
              if (token === 'token-a' && oldResponse === 'unauthorized') {
                await route.fulfill({
                  status: 401,
                  json: {
                    ok: false,
                    error: { code: 'UNAUTHORIZED', message: 'Old fixture token expired' },
                  },
                });
                return;
              }
              await route.fulfill({
                json: {
                  ok: true,
                  data: {
                    user: {
                      id: token === 'token-a' ? 'a' : 'b',
                      username: 'Member',
                      email: 'fixture@example.test',
                      role: 'member',
                    },
                  },
                },
              });
            });
            try {
              await page.goto(new URL('session-feedback-test', origin).href);
              await held.promise;
              await page.evaluate(async () => {
                const path = '/src/lib/session.ts';
                const session: typeof import('../../lib/session.ts') = await import(path);
                session.setSession('token-b', {
                  id: 'b',
                  username: 'B',
                  email: 'b@example.test',
                  role: 'member',
                });
              });
              release.done();
              await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
              assert.equal(
                await page.evaluate(
                  () => JSON.parse(localStorage.getItem('channel.user') ?? 'null')?.id,
                ),
                'b',
              );
              assert.equal(
                await page.evaluate(() => localStorage.getItem('channel.token')),
                'token-b',
              );
              assert.ok(bRequests > 0);
              assert.deepEqual(errors, []);
            } finally {
              release.done();
            }
          },
        );
    },
  );

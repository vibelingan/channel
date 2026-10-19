import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { parseDocument } from 'yaml';
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
            '../../../../../output/pricing-clock-repair-2026-10-13/p3e1/session-feedback-ui/',
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

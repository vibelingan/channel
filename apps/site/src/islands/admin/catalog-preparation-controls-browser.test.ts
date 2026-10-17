import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Route } from '@playwright/test';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const jobId = 'a'.repeat(64);
function progress(productId = 'alpha') {
  return {
    jobId,
    productId,
    state: 'queued',
    attempt: 0,
    leaseVersion: 0,
    leaseExpiresAt: 0,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    media: { total: 0, checked: 0, verified: 0, invalid: 0, retry: 0 },
  };
}
function status(ready = false, productId = 'alpha') {
  const p = progress(productId);
  if (ready) p.state = 'completed';
  const report = {
    schemaVersion: 'catalog-preparation-report-v2',
    productId,
    inputDigest: 'b'.repeat(64),
    policyVersion: 'catalog-preparation-v1',
    contentGeneration: 0,
    checkedAt: '2026-10-17T00:00:00.000Z',
    state: ready ? 'ready' : 'preparing',
    previewReady: true,
    mediaReady: ready,
    issues: [],
    ...(ready
      ? {
          seal: {
            kind: 'catalog-preparation-ready-seal-v1',
            jobId,
            receiptId: 'c'.repeat(64),
            planDigest: 'd'.repeat(64),
            imageIdsDigest: 'e'.repeat(64),
            imageCount: 0,
            mediaPolicyVersion: 'catalog-protected-media-seal-v1',
            pixelPolicyVersion: 'catalog-pixels-v1',
          },
        }
      : {}),
  };
  return {
    progress: p,
    current: true,
    report,
    attestation: ready ? { total: 0, checked: 0 } : null,
    nextAction: ready ? 'ready' : 'continue',
  };
}

test(
  'preparation controls in a real browser keep mount readonly, freeze actions and recover after reauthentication',
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-preparation-ui-vite-'));
    const { chromium, expect } = await import('@playwright/test');
    const { createServer } = await import('vite');
    const { default: tailwind } = await import('@tailwindcss/vite');
    const server = await createServer({
      configFile: false,
      cacheDir: directory,
      root: fileURLToPath(new URL('../../../', import.meta.url)),
      optimizeDeps: {
        noDiscovery: false,
        entries: ['src/islands/admin/testing/preparation-controls-browser-harness.tsx'],
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
          name: 'preparation-static-i18n-frontmatter',
          enforce: 'pre',
          transform(source, id) {
            if (!id.endsWith('.md') || !id.includes('/src/i18n/content/')) return;
            const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
            if (!match?.[1]) throw Error('Missing actual i18n frontmatter');
            const document = parseDocument(match[1], { uniqueKeys: true });
            if (document.errors.length) throw Error('Invalid actual i18n frontmatter');
            return {
              code: `export const frontmatter = ${JSON.stringify(document.toJSON())};`,
              map: null,
            };
          },
        },
        tailwind(),
        {
          name: 'preparation-browser-test',
          configureServer(server) {
            server.middlewares.use('/preparation-test', (_req, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(
                '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="preparation-test-root"></div></body></html>',
              );
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
    const browser = await chromium.launch({ headless: true });
    closeBrowser = () => browser.close();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const actions: string[] = [];
    let mode:
      | 'prepare'
      | 'ready'
      | 'unauthorized'
      | 'cancel-success'
      | 'cancel-unconfirmed'
      | 'retry-unconfirmed'
      | 'hold' = 'prepare';
    let continues = 0;
    let cancelled = false;
    let product = 'alpha';
    let held: Route | undefined;
    const heldRoute = () => held;
    await page.route('**/api/admin', async (route) => {
      const raw: unknown = route.request().postDataJSON();
      if (
        raw &&
        typeof raw === 'object' &&
        Reflect.get(raw, 'action') === 'catalogDetailApproval'
      ) {
        actions.push('preview');
        await route.fulfill({
          status: 400,
          json: {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Saved content requires correction.',
              issues: [
                {
                  code: 'TOO_LONG',
                  stage: 'effective-content',
                  path: 'name',
                  severity: 'error',
                  remedy: 'edit',
                  expected: { maxChars: 200 },
                  observed: { chars: 201 },
                },
              ],
            },
          },
        });
        return;
      }
      const body = z
        .object({
          action: z.literal('catalogPreparation'),
          data: z.object({
            action: z.string(),
            productId: z.string().optional(),
            jobId: z.string().optional(),
          }),
        })
        .parse(raw);
      const action = body.data.action;
      actions.push(action);
      if (mode === 'unauthorized') {
        await route.fulfill({
          status: 401,
          json: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Owned expired session' } },
        });
        return;
      }
      if (mode === 'hold' && action === 'continue') {
        held = route;
        return;
      }
      let data: unknown;
      if (mode === 'cancel-success') {
        if (action === 'cancel') {
          cancelled = true;
          data = { ok: true, progress: { ...progress(product), state: 'cancelled' } };
        } else if (action === 'retry') {
          cancelled = false;
          data = { ok: true, progress: { ...progress(product), leaseVersion: 1 } };
        } else
          data = {
            ok: true,
            status: cancelled
              ? {
                  ...status(false, product),
                  progress: { ...progress(product), state: 'cancelled' },
                  report: null,
                  nextAction: 'retry',
                }
              : status(false, product),
          };
      } else if (action === 'start') data = { ok: true, progress: progress(product) };
      else if (action === 'continue') {
        const done = ++continues >= 2;
        data = {
          ok: true,
          status: status(done, product),
          invocation: 'acknowledged',
          followUp: done ? 'none' : 'continue',
        };
      } else if (action === 'cancel') {
        assert.equal(mode, 'cancel-unconfirmed');
        data = { ok: true, status: status(false, product), recovery: 'status' };
      } else if (mode === 'retry-unconfirmed') {
        const value = {
          ...status(false, product),
          progress: { ...progress(product), state: 'cancelled' },
          report: null,
          nextAction: 'retry',
        };
        data = { ok: true, status: value, ...(action === 'retry' ? { recovery: 'status' } : {}) };
      } else data = { ok: true, status: status(mode === 'ready', product) };
      await route.fulfill({ json: { ok: true, data } });
    });
    const mount = async (id = 'alpha', actor = 'admin') =>
      page.evaluate(
        async ({ id, actor, modulePath }) => {
          const harness: typeof import('./testing/preparation-controls-browser-harness.tsx') =
            await import(modulePath);
          harness.signIn(actor);
          harness.renderControls(id);
        },
        {
          id,
          actor,
          modulePath: '/src/islands/admin/testing/preparation-controls-browser-harness.tsx',
        },
      );
    await page.goto(`${origin}preparation-test`);
    await mount();
    const panel = page.getByRole('region', { name: 'Saved product preparation' });
    await expect(
      panel.getByRole('button', { name: 'Prepare saved product', exact: true }),
    ).toBeVisible();
    assert.deepEqual(actions, []);
    await panel
      .getByRole('button', { name: 'Prepare saved product', exact: true })
      .evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw Error('Expected preparation button');
        button.click();
        button.click();
      });
    await expect(panel).toContainText('Saved product content is ready');
    assert.deepEqual(actions, ['start', 'continue', 'continue']);
    await expect(
      panel.getByRole('button', { name: 'Cancel preparation', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-ready-count', '1');
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    mode = 'ready';
    await page.reload();
    await mount();
    const before = actions.length;
    await expect(panel.getByRole('button', { name: 'Check result', exact: true })).toBeVisible();
    assert.equal(actions.length, before);
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(panel).toContainText('Saved product content is ready');
    assert.equal(actions.at(-1), 'status');
    mode = 'cancel-success';
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    const beforeConfirmedCancel = actions.length;
    await panel.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(panel).toContainText('Preparation was cancelled');
    await expect(
      panel.getByRole('button', { name: 'Continue preparation', exact: true }),
    ).toHaveCount(0);
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Retry preparation', exact: true }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(panel).toContainText('A saved preparation task is available');
    await expect(
      panel.getByRole('button', { name: 'Continue preparation', exact: true }),
    ).toBeEnabled();
    assert.deepEqual(actions.slice(beforeConfirmedCancel), [
      'status',
      'cancel',
      'status',
      'status',
      'retry',
    ]);
    mode = 'cancel-unconfirmed';
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Cancel preparation', exact: true }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(panel).toContainText('The result is not confirmed');
    await expect(panel).not.toContainText('Preparation was cancelled');
    mode = 'retry-unconfirmed';
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Retry preparation', exact: true }),
    ).toBeVisible();
    const beforeRetry = actions.length;
    await panel.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Retry preparation', exact: true }),
    ).toBeEnabled();
    assert.deepEqual(actions.slice(beforeRetry), ['status', 'retry']);
    await expect(panel).not.toContainText('Saved product content is ready');
    await expect(
      panel.getByRole('button', { name: 'Continue preparation', exact: true }),
    ).toHaveCount(0);
    mode = 'unauthorized';
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(panel.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
    mode = 'ready';
    await mount();
    await expect(panel.getByRole('button', { name: 'Check result', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(panel).toContainText('Saved product content is ready');
    const readyBeforeWrongProduct = await page.locator('body').getAttribute('data-ready-count');
    product = 'beta';
    const beforeWrongProduct = actions.length;
    await panel.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(panel).toContainText('The result is not confirmed');
    assert.deepEqual(actions.slice(beforeWrongProduct), ['status', 'status']);
    await expect(page.locator('body')).toHaveAttribute(
      'data-ready-count',
      readyBeforeWrongProduct ?? '0',
    );
    await expect(
      panel.getByRole('button', { name: 'Check current product', exact: true }),
    ).toBeVisible();
    product = 'alpha';
    await panel.getByRole('button', { name: 'Check current product', exact: true }).click();
    await expect(panel).toContainText('Saved product content is ready');
    mode = 'hold';
    product = 'beta';
    await mount('beta');
    await panel.getByRole('button', { name: 'Prepare saved product', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Stop waiting', exact: true })).toBeVisible();
    await expect.poll(() => held !== undefined).toBe(true);
    const oldRoute = heldRoute();
    assert.ok(oldRoute);
    const beforeUnrelatedStorage = actions.length;
    await page.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'unrelated.preference',
          newValue: 'changed',
          storageArea: window.localStorage,
        }),
      ),
    );
    await expect(panel.getByRole('button', { name: 'Stop waiting', exact: true })).toBeVisible();
    assert.equal(actions.length, beforeUnrelatedStorage);
    await mount('gamma');
    await expect(
      panel.getByRole('button', { name: 'Prepare saved product', exact: true }),
    ).toBeVisible();
    await oldRoute.fulfill({
      json: {
        ok: true,
        data: {
          ok: true,
          status: status(true, 'beta'),
          invocation: 'acknowledged',
          followUp: 'none',
        },
      },
    });
    await expect(panel).not.toContainText('Saved product content is ready');
    await panel.getByRole('button', { name: 'Edit saved product', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-edited-product', 'gamma');
    mode = 'hold';
    product = 'gamma';
    held = undefined;
    await panel.getByRole('button', { name: 'Prepare saved product', exact: true }).click();
    await expect.poll(() => held !== undefined).toBe(true);
    const stoppedRoute = heldRoute();
    assert.ok(stoppedRoute);
    const beforeStop = actions.length;
    await panel.getByRole('button', { name: 'Stop waiting', exact: true }).click();
    await expect(panel).toContainText('Waiting stopped');
    await expect(panel.getByRole('button', { name: 'Check result', exact: true })).toBeEnabled();
    assert.equal(actions.length, beforeStop);
    await stoppedRoute.fulfill({
      json: {
        ok: true,
        data: {
          ok: true,
          status: status(true, 'gamma'),
          invocation: 'acknowledged',
          followUp: 'none',
        },
      },
    });
    await expect(panel).not.toContainText('Saved product content is ready');
    await mount('alpha', 'other-admin');
    await expect(
      panel.getByRole('button', { name: 'Prepare saved product', exact: true }),
    ).toBeVisible();
    const beforeRoleChange = actions.length;
    await page.evaluate(async () => {
      const modulePath = '/src/islands/admin/testing/preparation-controls-browser-harness.tsx';
      const harness: typeof import('./testing/preparation-controls-browser-harness.tsx') =
        await import(modulePath);
      harness.signIn('other-admin', 'contributor');
    });
    await expect(panel).toHaveCount(0);
    assert.equal(actions.length, beforeRoleChange);
    await page.evaluate(async () => {
      const modulePath = '/src/islands/admin/testing/preparation-controls-browser-harness.tsx';
      const harness: typeof import('./testing/preparation-controls-browser-harness.tsx') =
        await import(modulePath);
      harness.signIn('preview-admin');
      harness.renderSavedPreview('broken-product');
    });
    await expect(
      page.getByRole('button', { name: 'Open item to repair', exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Prepare saved product', exact: true }),
    ).toBeVisible();
    assert.ok(actions.slice(beforeRoleChange).every((action) => action === 'preview'));
    await page.getByRole('button', { name: 'Open item to repair', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-edited-product', 'broken-product');
    t.diagnostic(
      'Executed: readonly mount, mobile width, duplicate action, ready, reload recovery, confirmed cancel/retry, unknown cancel/retry, sameactor reauth, wrongproduct refusal/currentproduct recovery, product-switch late result, stopwait without cancel, actor isolation, unrelated-storage continuity, contributor gate, real preview-error edit fallback.',
    );
    assert.deepEqual(errors, []);
  },
);

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import {
  APPROVAL_JOBS,
  APPROVED_VARIANTS,
} from '../../../../../packages/db/src/catalog-detail-staging.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { setMediaStorage } from '../../../../../packages/media-storage/src/index.ts';
import { LocalDiskMediaStorage } from '../../../../../packages/media-storage/src/local-disk.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { fixture as sourceFixture } from '../../../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';

for (const overlapping of [false, true]) {
  test(
    `broken preview opens the real raw editor; ${overlapping ? 'overlapping' : 'independent'} read retries retain edits and save an unclassified draft`,
    { timeout: 90000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'channel-editor-recovery-'));
      let closeBrowser = async () => {};
      let closeServer = async () => {};
      t.after(async () => {
        await closeBrowser();
        await closeServer();
        await rm(dir, { recursive: true, force: true });
      });
      const cache = join(dir, 'vite');
      const h = sourceFixture(2);
      const original = h.adapter.rows.products?.[0];
      assert.ok(original);
      Reflect.deleteProperty(original, 'productFamily');
      original.alibabaReviewPending = true;
      original.alibabaReviewReason = 'changed';
      const file = join(dir, 'db.json');
      await writeFile(file, JSON.stringify(h.adapter.rows));
      const adapter = new JsonFileAdapter(file);
      setAdapter(adapter);
      setMediaStorage(new LocalDiskMediaStorage(join(dir, 'media')));
      const before = JSON.parse(await readFile(file, 'utf8'));
      const config = { jwtSecret: 'owned-editor-recovery', enableDetailApproval: true };
      const token = await signSession(config.jwtSecret, {
        sub: 'admin',
        email: 'admin@example.test',
        name: 'Admin',
        role: 'admin',
      });
      const invoke = async (body: string, headers: Record<string, string> = {}) => {
        const r = await handleAdminFunctionEvent(
          { httpMethod: 'POST', headers, body },
          config,
          handleAdminRequest,
        );
        assert.ok('statusCode' in r);
        return r;
      };
      for (const action of ['supplier-review', 'photo-sources']) {
        const r = await invoke(
          JSON.stringify({
            action: 'catalogDetailApproval',
            token,
            data: { action, productId: original._id },
          }),
        );
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(JSON.parse(r.body).ok, true);
      }
      const { chromium, expect } = await import('@playwright/test');
      const { createServer } = await import('vite');
      const { default: tailwind } = await import('@tailwindcss/vite');
      const server = await createServer({
        configFile: false,
        cacheDir: cache,
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        optimizeDeps: {
          noDiscovery: false,
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
            name: 'editor-real-i18n-frontmatter',
            enforce: 'pre',
            transform(source, id) {
              if (!id.endsWith('.md') || !id.includes('/src/i18n/content/')) return;
              const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
              if (!match?.[1]) throw Error('Missing actual i18n frontmatter');
              const document = parseDocument(match[1], { uniqueKeys: true });
              if (document.errors.length) throw Error('Invalid actual i18n frontmatter');
              return {
                code: `export const frontmatter=${JSON.stringify(document.toJSON())};`,
                map: null,
              };
            },
          },
          tailwind(),
          {
            name: 'editor-test-page',
            configureServer(server) {
              server.middlewares.use('/editor-test', (_req, response) => {
                response.setHeader('Content-Type', 'text/html');
                response.end(
                  '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="editor-recovery-root"></div></body></html>',
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const counts = new Map<string, number>();
      const successes = new Map<string, number>();
      let releaseSupplier: (() => Promise<void>) | undefined;
      const heldSupplier = () => releaseSupplier;
      let failSupplier = true;
      let failPhotos = true;
      await page.route('**/api/admin', async (route) => {
        const bodyText = route.request().postData();
        assert.ok(bodyText);
        const body = z
          .object({
            action: z.string(),
            data: z.object({ action: z.string().optional() }).passthrough().optional(),
          })
          .parse(JSON.parse(bodyText));
        const action =
          body.action === 'catalogDetailApproval' ? (body.data?.action ?? 'detail') : body.action;
        counts.set(action, (counts.get(action) ?? 0) + 1);
        if (action === 'preview') {
          await route.fulfill({
            status: 400,
            json: {
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Owned invalid preview',
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
        if (
          (action === 'supplier-review' && failSupplier) ||
          (action === 'photo-sources' && failPhotos)
        ) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned temporary read failure' },
            },
          });
          return;
        }
        const r = await invoke(bodyText);
        if (r.statusCode === 200 && JSON.parse(r.body).ok === true)
          successes.set(action, (successes.get(action) ?? 0) + 1);
        if (overlapping && action === 'supplier-review') {
          releaseSupplier = () =>
            route.fulfill({ status: r.statusCode, headers: r.headers, body: r.body });
          return;
        }
        await route.fulfill({ status: r.statusCode, headers: r.headers, body: r.body });
      });
      await page.goto(`${origin}editor-test`);
      await page.evaluate(
        async ({ productId, token, modulePath }) => {
          const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
            await import(modulePath);
          harness.renderPreview(productId, token);
        },
        {
          productId: original._id,
          token,
          modulePath: '/src/islands/admin/testing/editor-recovery-browser-harness.tsx',
        },
      );
      await page.getByRole('button', { name: 'Open item to repair', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Repair saved product', exact: true });
      await expect(form).toBeVisible();
      await expect(form.locator('#name')).toHaveValue('Website title');
      await expect.poll(() => counts.get('supplier-review') ?? 0).toBeGreaterThan(0);
      await expect.poll(() => counts.get('photo-sources') ?? 0).toBeGreaterThan(0);
      const supplierRetry = form.getByRole('button', {
        name: 'Retry Alibaba changes',
        exact: true,
      });
      const photoRetry = form.getByRole('button', { name: 'Retry Alibaba photos', exact: true });
      const available = await Promise.allSettled([
        expect(supplierRetry).toBeVisible(),
        expect(photoRetry).toBeVisible(),
      ]);
      assert.deepEqual(
        available.map((value) => value.status),
        ['fulfilled', 'fulfilled'],
        'Both failed reads need an independent retry',
      );
      const supplierBefore = counts.get('supplier-review') ?? 0;
      const photosBefore = counts.get('photo-sources') ?? 0;
      await form.locator('#name').fill('My repaired clock');
      await form.locator('#description').fill('My unsaved description');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        counts.get('supplier-review'),
        supplierBefore,
        'Typing must not reload supplier data',
      );
      assert.equal(counts.get('photo-sources'), photosBefore, 'Typing must not reload photos');
      failSupplier = false;
      await supplierRetry.click();
      if (!overlapping) {
        await expect.poll(() => successes.get('supplier-review') ?? 0).toBe(1);
        await expect(form.getByText('Loading Alibaba changes…', { exact: true })).toHaveCount(0);
        await expect(supplierRetry).toHaveCount(0);
      } else {
        await expect.poll(() => heldSupplier() !== undefined).toBe(true);
        await expect(form.getByText('Loading Alibaba changes…', { exact: true })).toBeVisible();
      }
      assert.equal(counts.get('supplier-review'), supplierBefore + 1);
      assert.equal(counts.get('photo-sources'), photosBefore);
      await expect(form.locator('#name')).toHaveValue('My repaired clock');
      await expect(form.locator('#description')).toHaveValue('My unsaved description');
      failPhotos = false;
      await photoRetry.click();
      await expect.poll(() => successes.get('photo-sources') ?? 0).toBe(1);
      await expect(form.getByText('Loading Alibaba photos…', { exact: true })).toHaveCount(0);
      await expect(photoRetry).toHaveCount(0);
      assert.equal(counts.get('photo-sources'), photosBefore + 1);
      assert.equal(counts.get('supplier-review'), supplierBefore + 1);
      const expectedName = overlapping ? 'My edit during a pending read' : 'My repaired clock';
      if (overlapping) {
        await expect(form.getByText('Loading Alibaba changes…', { exact: true })).toBeVisible();
        await form.locator('#name').fill(expectedName);
        const release = heldSupplier();
        assert.ok(release);
        await release();
        await expect(form.getByText('Loading Alibaba changes…', { exact: true })).toHaveCount(0);
        await expect(supplierRetry).toHaveCount(0);
      }
      await expect(form.locator('#name')).toHaveValue(expectedName);
      await expect(form.locator('#description')).toHaveValue('My unsaved description');
      assert.equal(counts.get('supplier-review'), supplierBefore + 1);
      assert.equal(counts.get('photo-sources'), photosBefore + 1);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
      const after = JSON.parse(await readFile(file, 'utf8'));
      const saved = after.products.find((row: { _id: string }) => row._id === original._id);
      assert.ok(saved);
      assert.equal(saved.name, expectedName);
      assert.equal(saved.description, 'My unsaved description');
      assert.equal(saved.published, false);
      assert.equal(saved.productFamily, undefined);
      assert.deepEqual(saved.imageIds, before.products[0].imageIds);
      assert.deepEqual(after.catalogSourceObservations, before.catalogSourceObservations);
      assert.deepEqual(after.catalogSourceLinks ?? [], before.catalogSourceLinks ?? []);
      assert.deepEqual(after[APPROVAL_JOBS] ?? [], before[APPROVAL_JOBS] ?? []);
      assert.deepEqual(after[APPROVED_VARIANTS] ?? [], before[APPROVED_VARIANTS] ?? []);
      assert.deepEqual(saved.catalogDetailPublication, before.products[0].catalogDetailPublication);
      assert.deepEqual(
        saved.catalogDetailApprovalReceipt,
        before.products[0].catalogDetailApprovalReceipt,
      );
      for (const field of [
        'alibabaReviewPending',
        'alibabaReviewReason',
        'alibabaReviewedAt',
        'alibabaReviewedByUserId',
      ])
        assert.deepEqual(saved[field], before.products[0][field]);
      assert.equal(counts.get('update'), 1);
      for (const action of ['create', 'prepare', 'begin', 'page', 'finish'])
        assert.equal(counts.get(action) ?? 0, 0);
      assert.equal((after.catalogPreparationJobs ?? []).length, 0);
      assert.deepEqual(errors, []);
      t.diagnostic(
        'Actual client + signed adminHTTP + JSON: invalid preview -> raw editor -> independent supplier/photo retry with edits retained -> guarded save, unpublished/unclassified and source/media unchanged.',
      );
    },
  );
}

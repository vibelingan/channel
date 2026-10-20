import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import {
  APPROVAL_JOBS,
  APPROVED_VARIANTS,
} from '../../../../../packages/db/src/catalog-detail-staging.ts';
import { createCatalogPreparationAuthority } from '../../../../../packages/db/src/catalog-preparation-authority.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import {
  type UploadCredential,
  setMediaStorage,
} from '../../../../../packages/media-storage/src/index.ts';
import { LocalDiskMediaStorage } from '../../../../../packages/media-storage/src/local-disk.ts';
import { runCatalogPreparationWorker } from '../../../../functions/admin/src/catalog-preparation-worker.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { fixture as sourceFixture } from '../../../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { handleAlibabaSyncFunctionEvent } from '../../../../functions/alibaba-catalog-sync/src/http-adapter.ts';
import { importCandidateImage } from '../../../../functions/alibaba-catalog-sync/src/media-import.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';

function assertOriginalDraftSave(
  after: Record<string, unknown>,
  product: Record<string, unknown>,
  counts: Map<string, number>,
  saveRequests = 1,
) {
  const roots = z
    .array(
      z.object({
        state: z.literal('saved'),
        productId: z.string(),
        operation: z.object({
          protocolVersion: z.literal(2),
          intent: z.literal('save-draft'),
          values: z.record(z.unknown()),
          photoClaimVersion: z.number().optional(),
          photoReleaseVersion: z.number().optional(),
        }),
        saved: z.object({ productUpdatedAt: z.string() }),
      }),
    )
    .parse(after[APPROVAL_JOBS]);
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.ok(root);
  assert.equal(root.productId, product._id);
  assert.equal(root.saved.productUpdatedAt, product.updatedAt);
  assert.equal(root.operation.photoClaimVersion ?? 0, root.operation.photoReleaseVersion ?? 0);
  assert.equal(root.operation.values.published, undefined);
  assert.equal(root.operation.values.archived, undefined);
  assert.equal(counts.get('update') ?? 0, 0);
  assert.equal(counts.get('product-operation-start'), 1);
  assert.equal(counts.get('product-operation-save'), saveRequests);
}

const scenarios = [
  'independent',
  'overlapping',
  'save-reply-lost',
  'save-and-check-lost',
  'multiple-original-saves',
  'start-before-lost',
  'session-reconnect',
  'initial-session-missing',
  'publish-full',
  'publish-lost-completion',
  'publish-before-start',
  'publish-public-read',
  'publish-late-private-read',
  'publish-missing-category',
  'publish-review-required',
  'gallery',
  'description',
  'gallery-capacity',
  'description-capacity',
  'gallery-duplicate',
  'description-duplicate',
  'gallery-upload-late',
  'description-upload-late',
  'gallery-upload-first',
  'description-upload-first',
  'gallery-upload-start-first',
  'description-upload-start-first',
  'gallery-import-retry',
  'description-import-retry',
  'gallery-cleanup-continue',
  'description-cleanup-stop',
] as const;
for (const [scenario, engine] of [
  ...scenarios.map((scenario) => [scenario, 'chromium'] as const),
  ['multiple-original-saves', 'webkit'] as const,
]) {
  const overlapping = scenario === 'overlapping';
  const publishing = scenario.startsWith('publish-');
  const mediaRace = scenario.startsWith('gallery') || scenario.startsWith('description');
  const uploadLate = scenario.endsWith('-upload-late');
  const uploadStartFirst = scenario.endsWith('-upload-start-first');
  const concurrent = uploadLate || scenario.endsWith('-upload-first');
  const capacity = scenario.endsWith('-capacity');
  const duplicate = scenario.endsWith('-duplicate');
  const importRetry = scenario.endsWith('-import-retry');
  const purpose = scenario.startsWith('description') ? 'description' : 'gallery';
  test(
    `${engine} broken preview opens real editor; ${scenario} reads or photo completion preserve current edits and draft state`,
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
      let cleanupBlocked = scenario.includes('-cleanup-');
      const persist = adapter.persistCatalogDetailApproval.bind(adapter);
      t.mock.method(
        adapter,
        'persistCatalogDetailApproval',
        async (...args: Parameters<typeof persist>) => {
          if (cleanupBlocked && args[1].action === 'operation-photo-release')
            throw Error('Owned photo cleanup unavailable');
          return persist(...args);
        },
      );
      setAdapter(adapter);
      const mediaDirectory = join(dir, 'media');
      const uploadPaths = new Map<string, string>();
      class BrowserStorage extends LocalDiskMediaStorage {
        override async getUploadCredential(cloudPath: string): Promise<UploadCredential> {
          const uploadUrl = `https://owned-upload.invalid/${encodeURIComponent(cloudPath)}`;
          uploadPaths.set(uploadUrl, cloudPath);
          return {
            uploadUrl,
            method: 'PUT',
            storageFileId: `local-disk:${cloudPath}`,
            headers: {
              Signature: 'fixture',
              'x-cos-security-token': 'fixture',
              'x-cos-meta-fileid': 'fixture',
              authorization: 'fixture',
              key: encodeURIComponent(cloudPath),
            },
          };
        }
      }
      const mediaStorage = new BrowserStorage(mediaDirectory);
      setMediaStorage(mediaStorage);
      const sourceUrl = 'https://sc04.alicdn.com/editor-new.png';
      const oldIds: string[] = [];
      const field = purpose === 'description' ? 'descriptionImageIds' : 'imageIds';
      const sharp = (await import('sharp')).default;
      const pixels = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 3,
          background: duplicate ? `#${(3 * 121177).toString(16).padStart(6, '0')}` : '#778899',
        },
      })
        .png()
        .toBuffer();
      const uploadPixels = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#fafafa' },
      })
        .png()
        .toBuffer();
      if (mediaRace) {
        const count = capacity
          ? purpose === 'gallery'
            ? 8
            : 17
          : concurrent
            ? purpose === 'gallery'
              ? 7
              : 16
            : 3;
        for (let index = 0; index < count; index++) {
          const color = `#${((index + 1) * 121177).toString(16).padStart(6, '0')}`;
          const oldPixels = await sharp({
            create: { width: 2, height: 2, channels: 3, background: color },
          })
            .png()
            .toBuffer();
          const imported = await importCandidateImage(
            `https://sc04.alicdn.com/editor-old-${index}.png`,
            {
              resolveDns: async () => ['104.16.1.1'],
              fetchImpl: async () => new Response(new Uint8Array(oldPixels)),
            },
          );
          assert.ok(imported.ok, JSON.stringify(imported));
          oldIds.push(imported.imageId);
        }
        await adapter.update('products', original._id, {
          [field]: oldIds,
          [purpose === 'description' ? 'alibabaDescriptionImageUrls' : 'alibabaSourceImageUrls']: [
            sourceUrl,
          ],
        });
      }
      if (publishing) {
        const object = await mediaStorage.putObject({
          namespace: 'catalog',
          logicalId: 'editor-publication-photo',
          fileName: 'photo.png',
          mimeType: 'image/png',
          content: pixels,
        });
        await adapter.create('images', {
          _id: 'editor-publication-photo',
          ...object,
          mimeType: 'image/png',
          byteSize: pixels.length,
          checksumSha256: createHash('sha256').update(pixels).digest('hex'),
          status: 'active',
          publishedRefCount: 0,
        });
        await adapter.update('products', original._id, {
          imageIds: ['editor-publication-photo'],
          ...(scenario !== 'publish-missing-category' ? { productFamily: 'misc' } : {}),
        });
      }
      const before = JSON.parse(await readFile(file, 'utf8'));
      const authority = createCatalogPreparationAuthority({
        secret: 'owned-editor-recovery',
        environmentId: 'owned-editor-recovery',
      });
      const config = {
        jwtSecret: 'owned-editor-recovery',
        enableDetailApproval: true,
        preparationAuthority: authority,
        preparationInvoke: async (call: Parameters<typeof runCatalogPreparationWorker>[1]) => ({
          result: await runCatalogPreparationWorker(authority, call, {
            importSourceImage: (url, persistImport) =>
              importCandidateImage(url, {
                persistImport,
                resolveDns: async () => ['104.16.1.1'],
                fetchImpl: async () => new Response(new Uint8Array(pixels)),
              }),
          }),
        }),
      };
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
      const playwright = await import('@playwright/test');
      const { expect } = playwright;
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
      const browser = await playwright[engine].launch({ headless: true });
      closeBrowser = () => browser.close();
      const page = await browser.newPage({
        viewport: {
          width: importRetry || scenario === 'multiple-original-saves' ? 390 : 1280,
          height: 900,
        },
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const counts = new Map<string, number>();
      const successes = new Map<string, number>();
      let releaseSupplier: (() => Promise<void>) | undefined;
      const heldSupplier = () => releaseSupplier;
      let failSupplier = !mediaRace;
      let failPhotos = !mediaRace;
      let releaseImport: (() => Promise<void>) | undefined;
      let releaseUpload: (() => Promise<void>) | undefined;
      let copiedId = '';
      let uploadedId = '';
      let importRequests = 0;
      let saveReplyDropped = false;
      let startDropped = false;
      let removedLocalActor = false;
      let publicBlocked = scenario === 'publish-public-read';
      let publicReads = 0;
      let latePrivateDropped = false;
      let blockSaveConfirmation = ['save-and-check-lost', 'multiple-original-saves'].includes(
        scenario,
      );
      await page.route('https://sc04.alicdn.com/**', (route) =>
        route.fulfill({ contentType: 'image/png', body: pixels }),
      );
      await page.route('https://owned-upload.invalid/**', async (route) => {
        assert.equal(route.request().method(), 'PUT');
        const path = uploadPaths.get(route.request().url());
        assert.ok(path, 'Only a credential from the real intent handler may accept bytes');
        const bytes = route.request().postDataBuffer();
        assert.ok(bytes);
        await mkdir(dirname(join(mediaDirectory, path)), { recursive: true });
        await writeFile(join(mediaDirectory, path), bytes);
        await route.fulfill({ status: 200, body: '' });
      });
      await page.route('**/api/alibaba-catalog-sync', async (route) => {
        importRequests++;
        const body = route.request().postData();
        assert.ok(body);
        assert.equal(JSON.parse(body).action, 'importSourceImage');
        assert.equal(JSON.parse(body).data.url, sourceUrl);
        assert.equal(JSON.parse(body).token, token);
        if (importRetry && importRequests === 1) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned temporary copy failure' },
            },
          });
          return;
        }
        const imported = await importCandidateImage(sourceUrl, {
          resolveDns: async () => ['104.16.1.1'],
          fetchImpl: async () => new Response(new Uint8Array(pixels)),
        });
        assert.ok(imported.ok, JSON.stringify(imported));
        copiedId = imported.imageId;
        const result = await handleAlibabaSyncFunctionEvent({ httpMethod: 'POST', body }, config);
        assert.ok('statusCode' in result);
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(JSON.parse(result.body).data.imageId, copiedId);
        releaseImport = () =>
          route.fulfill({ status: result.statusCode, headers: result.headers, body: result.body });
      });
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
        if (
          scenario === 'publish-late-private-read' &&
          action === 'get' &&
          publicReads > 0 &&
          !latePrivateDropped &&
          (await page.evaluate(
            () =>
              Object.keys(localStorage).filter((key) => key.startsWith('channel:publication:'))
                .length,
          )) === 0
        ) {
          latePrivateDropped = true;
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: {
                code: 'UNAVAILABLE',
                message: 'Owned final private read unavailable after public confirmation',
              },
            },
          });
          return;
        }
        if (scenario === 'initial-session-missing' && action === 'get' && !removedLocalActor) {
          removedLocalActor = true;
          await page.evaluate(() => localStorage.removeItem('channel.user'));
        }
        if (
          (['start-before-lost', 'publish-before-start'].includes(scenario) &&
            action === 'product-operation-start' &&
            !startDropped) ||
          (blockSaveConfirmation && saveReplyDropped && action === 'product-operation-get')
        ) {
          startDropped = true;
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned original request unavailable' },
            },
          });
          return;
        }
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
        if (
          scenario === 'publish-lost-completion' &&
          action === 'product-operation-continue' &&
          !saveReplyDropped &&
          r.statusCode === 200 &&
          JSON.parse(r.body).data.state === 'complete'
        ) {
          saveReplyDropped = true;
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned publication completed but reply lost' },
            },
          });
          return;
        }
        if (
          ['save-reply-lost', 'save-and-check-lost', 'multiple-original-saves'].includes(
            scenario,
          ) &&
          action === 'product-operation-save' &&
          !saveReplyDropped
        ) {
          assert.equal(r.statusCode, 200, r.body);
          saveReplyDropped = true;
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned save committed but reply lost' },
            },
          });
          return;
        }
        if (action === 'completeUpload') {
          assert.equal(r.statusCode, 200, r.body);
          uploadedId = JSON.parse(r.body).data.imageId;
        }
        if ((uploadLate || uploadStartFirst) && action === 'completeUpload') {
          assert.equal(r.statusCode, 200, r.body);
          releaseUpload = () =>
            route.fulfill({ status: r.statusCode, headers: r.headers, body: r.body });
          return;
        }
        if (r.statusCode === 200 && JSON.parse(r.body).ok === true)
          successes.set(action, (successes.get(action) ?? 0) + 1);
        if (overlapping && action === 'supplier-review') {
          releaseSupplier = () =>
            route.fulfill({ status: r.statusCode, headers: r.headers, body: r.body });
          return;
        }
        await route.fulfill({ status: r.statusCode, headers: r.headers, body: r.body });
      });
      await page.route('**/api/products/**', async (route) => {
        publicReads++;
        assert.equal(route.request().headers().authorization, undefined);
        if (publicBlocked) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: { code: 'UNAVAILABLE', message: 'Owned public read unavailable' },
            },
          });
          return;
        }
        const url = new URL(route.request().url());
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
          body: response.body,
        });
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
      if (scenario === 'initial-session-missing') {
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await page.evaluate(
          async ({ token, modulePath }) => {
            const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
              await import(modulePath);
            harness.setEditorSession(token, 'admin');
          },
          { token, modulePath: '/src/islands/admin/testing/editor-recovery-browser-harness.tsx' },
        );
        await expect(
          form.getByRole('button', { name: 'Reconnect original account', exact: true }),
        ).toHaveCount(0);
        await expect(
          form.getByText(
            'Download your edits, then close and reopen this product after signing in. This form could not confirm its original account.',
            { exact: true },
          ),
        ).toBeVisible();
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByText('Editor closed', { exact: true })).toBeVisible();
        assert.equal(counts.get('product-operation-start') ?? 0, 0);
        assert.equal(counts.get('update') ?? 0, 0);
        assert.deepEqual(await adapter.get('products', original._id), before.products[0]);
        assert.deepEqual(errors, []);
        return;
      }
      await expect.poll(() => counts.get('supplier-review') ?? 0).toBeGreaterThan(0);
      await expect.poll(() => counts.get('photo-sources') ?? 0).toBeGreaterThan(0);
      if (mediaRace) {
        const manager = form.locator(`[data-image-manager="${purpose}"]`);
        const fileInput = manager.locator('input[type="file"]');
        const ids = () =>
          manager
            .locator('[data-image-id]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-image-id')));
        const add = form.getByRole('button', {
          name: purpose === 'gallery' ? 'Add Alibaba photo 1' : 'Add Alibaba description photo 1',
          exact: true,
        });
        const keep = form
          .getByRole('button', { name: 'Keep website version', exact: true })
          .first();
        const useIncoming = form.getByRole('button', { name: /^Use Alibaba/ }).first();
        const save = form.getByRole('button', { name: 'Save', exact: true });
        const chooseFiles = (count: number) =>
          fileInput.setInputFiles(
            Array.from({ length: count }, (_, index) => ({
              name: `owned-${index}.png`,
              mimeType: 'image/png',
              buffer: uploadPixels,
            })),
          );
        const finishSource = async () => {
          const release = releaseImport;
          assert.ok(release);
          await release();
          await expect(manager.getByText('Adding Alibaba photo…', { exact: true })).toHaveCount(0);
          await expect(
            form.getByText(
              duplicate
                ? 'Photo is already selected. Save to keep it.'
                : 'Photo added. Save to keep it.',
              { exact: true },
            ),
          ).toBeVisible();
        };
        await expect.poll(ids).toEqual(oldIds);
        await expect(keep).toBeVisible();
        await expect(keep).toBeEnabled();
        await expect(add).toBeEnabled();
        if (uploadStartFirst) {
          await chooseFiles(1);
          await expect.poll(() => releaseUpload !== undefined).toBe(true);
          await expect(add).toBeDisabled();
          await expect(keep).toBeDisabled();
          await expect(useIncoming).toBeDisabled();
          await form.locator('#name').fill('Editing during pending upload');
          const release = releaseUpload;
          assert.ok(release);
          await release();
          await expect(save).toBeEnabled();
          await expect(add).toBeEnabled();
          await expect.poll(ids).toEqual([...oldIds, uploadedId]);
        }
        if (importRetry) await form.locator('#name').fill('Draft retained across photo retry');
        await add.click();
        if (importRetry) {
          await expect(
            form.getByText('Owned temporary copy failure', { exact: true }),
          ).toBeVisible();
          await expect(manager.getByText('Adding Alibaba photo…', { exact: true })).toHaveCount(0);
          await expect(add).toBeEnabled();
          await expect(fileInput).toBeEnabled();
          await expect(keep).toBeEnabled();
          await expect(useIncoming).toBeEnabled();
          await expect(form.locator('#name')).toHaveValue('Draft retained across photo retry');
          await expect.poll(ids).toEqual(oldIds);
          assert.equal(counts.get('update') ?? 0, 0);
          await add.click();
          await expect(form.locator('#name')).toHaveValue('Draft retained across photo retry');
        }
        await expect.poll(() => releaseImport !== undefined).toBe(true);
        await expect(save).toBeDisabled();
        await expect(
          form.getByRole('button', { name: 'Close editor', exact: true }),
        ).toBeDisabled();
        await expect(keep).toBeDisabled();
        await expect(useIncoming).toBeDisabled();
        await expect(manager.getByText('Adding Alibaba photo…', { exact: true })).toBeVisible();
        let expected: string[];
        if (capacity) {
          await expect(fileInput).toBeDisabled();
          assert.equal(counts.get('createUploadIntent') ?? 0, 0);
          await finishSource();
          expected = [...oldIds, copiedId];
          await expect.poll(ids).toEqual(expected);
          // Free and reuse the source copy without another request.
          await manager
            .locator(`[data-image-id="${copiedId}"]`)
            .getByRole('button', { name: 'Remove image', exact: true })
            .click();
          await expect(fileInput).toBeEnabled();
          await add.click();
          await expect.poll(ids).toEqual(expected);
          assert.equal(importRequests, 1);
          await manager
            .locator(`[data-image-id="${oldIds[0]}"]`)
            .getByRole('button', { name: 'Remove image', exact: true })
            .click();
          await chooseFiles(1);
          await expect(save).toBeEnabled();
          await expect.poll(() => uploadedId !== '').toBe(true);
          expected = [...oldIds.slice(1), copiedId, uploadedId];
          await expect.poll(ids).toEqual(expected);
        } else if (concurrent) {
          await expect(fileInput).toBeEnabled();
          await chooseFiles(2);
          await expect(
            manager.getByText('1 file not selected. Remove an image to add more.', {
              exact: false,
            }),
          ).toBeVisible();
          if (uploadLate) {
            await expect.poll(() => releaseUpload !== undefined).toBe(true);
            await finishSource();
            await expect(
              form.getByRole('button', { name: 'Waiting for uploads…', exact: true }),
            ).toBeDisabled();
            await expect(keep).toBeDisabled();
            const release = releaseUpload;
            assert.ok(release);
            await release();
            await expect(save).toBeEnabled();
            expected = [...oldIds, copiedId, uploadedId];
          } else {
            await expect.poll(() => uploadedId !== '').toBe(true);
            await expect.poll(ids).toEqual([...oldIds, uploadedId]);
            await finishSource();
            await expect(save).toBeEnabled();
            expected = [...oldIds, uploadedId, copiedId];
          }
          await expect.poll(ids).toEqual(expected);
          assert.equal(expected.length, purpose === 'gallery' ? 9 : 18);
        } else if (uploadStartFirst) {
          await finishSource();
          expected = [...oldIds, uploadedId, copiedId];
          await expect.poll(ids).toEqual(expected);
        } else {
          await manager
            .locator(`[data-image-id="${oldIds[0]}"]`)
            .getByRole('button', { name: 'Remove image', exact: true })
            .click();
          await manager
            .locator(`[data-image-id="${oldIds[2]}"]`)
            .getByRole('button', { name: 'Move left', exact: true })
            .click();
          await form.locator('#name').fill('Edited while source photo imports');
          await form.locator('#description').fill('Description retained during photo import');
          await expect.poll(ids).toEqual([oldIds[2], oldIds[1]]);
          await finishSource();
          expected = duplicate ? [oldIds[2], oldIds[1]] : [oldIds[2], oldIds[1], copiedId];
          if (duplicate) assert.equal(copiedId, oldIds[2]);
          await expect.poll(ids).toEqual(expected);
        }
        if (capacity || concurrent || uploadStartFirst) {
          await form.locator('#name').fill('Edited while source photo imports');
          await form.locator('#description').fill('Description retained during photo import');
          assert.equal(counts.get('createUploadIntent'), 1);
          assert.equal(counts.get('completeUpload'), 1);
        }
        await expect(keep).toBeEnabled();
        await expect(useIncoming).toBeEnabled();
        await keep.click();
        await expect(keep).toHaveAttribute('aria-pressed', 'true');
        await expect(form.locator('#name')).toHaveValue('Edited while source photo imports');
        await expect(form.locator('#description')).toHaveValue(
          'Description retained during photo import',
        );
        const beforeSave = JSON.parse(await readFile(file, 'utf8'));
        assert.deepEqual(
          beforeSave.products,
          before.products,
          'Imports and unsaved selections do not save product content',
        );
        assert.deepEqual(beforeSave[APPROVAL_JOBS] ?? [], []);
        assert.deepEqual(beforeSave[APPROVED_VARIANTS] ?? [], []);
        assert.equal(counts.get('update') ?? 0, 0);
        if (importRetry) {
          const width = await form
            .locator('[data-record-form-body]')
            .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
          assert.ok(width.scroll <= width.client + 1, JSON.stringify(width));
        }
        await save.click();
        if (scenario.includes('-cleanup-')) {
          await expect(
            form.getByText(
              'The product save is recorded. Continue or stop this original save to finish its photo cleanup.',
              { exact: true },
            ),
          ).toBeVisible();
          const recorded = await adapter.get('products', original._id);
          assert.ok(recorded);
          await expect(save).toBeDisabled();
          await form.getByRole('button', { name: 'Check original save', exact: true }).click();
          await expect(
            form.getByRole('button', { name: 'Continue original save', exact: true }),
          ).toBeEnabled();
          assert.deepEqual(await adapter.get('products', original._id), recorded);
          if (scenario.endsWith('-continue')) {
            cleanupBlocked = false;
            await form.getByRole('button', { name: 'Continue original save', exact: true }).click();
            await expect(
              form.getByText(
                'The original draft save is confirmed. Your current form edits have been kept.',
                { exact: true },
              ),
            ).toBeVisible();
          } else {
            await form.getByRole('button', { name: 'Stop original save', exact: true }).click();
            await expect(
              form.getByText(
                'The original save is historical. Download your edits before opening the current product.',
                { exact: true },
              ),
            ).toBeVisible();
          }
          const after = JSON.parse(await readFile(file, 'utf8'));
          assertOriginalDraftSave(after, recorded, counts, scenario.endsWith('-continue') ? 2 : 1);
          assert.deepEqual(await adapter.get('products', original._id), recorded);
          for (const image of after.images) assert.ok(!image.imageMutationOwner);
          assert.deepEqual(recorded[field], expected);
          const download = page.waitForEvent('download');
          await form.getByRole('button', { name: 'Download current edits', exact: true }).click();
          await download;
          await form.getByRole('button', { name: 'Open saved product', exact: true }).click();
          await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
          await expect(form.locator('#description')).toHaveValue(
            'Description retained during photo import',
          );
          assert.deepEqual(errors, []);
          return;
        }
        await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
        const after = JSON.parse(await readFile(file, 'utf8'));
        const saved = after.products.find((row: { _id: string }) => row._id === original._id);
        assert.deepEqual(saved[field], expected);
        const otherField = field === 'imageIds' ? 'descriptionImageIds' : 'imageIds';
        assert.deepEqual(saved[otherField], before.products[0][otherField]);
        assert.equal(saved.name, 'Edited while source photo imports');
        assert.equal(saved.description, 'Description retained during photo import');
        assert.equal(saved.published, false);
        assert.equal(saved.productFamily, undefined);
        assert.deepEqual(
          saved.catalogDetailPublication,
          before.products[0].catalogDetailPublication,
        );
        assert.deepEqual(
          saved.catalogDetailApprovalReceipt,
          before.products[0].catalogDetailApprovalReceipt,
        );
        for (const action of ['create', 'prepare', 'begin', 'page', 'finish'])
          assert.equal(counts.get(action) ?? 0, 0);
        assert.equal((after.catalogPreparationJobs ?? []).length, 0);
        assert.equal(new Set(saved[field]).size, saved[field].length);
        assert.ok(saved[field].length <= (purpose === 'gallery' ? 9 : 18));
        assert.deepEqual(after.catalogSourceObservations, before.catalogSourceObservations);
        assertOriginalDraftSave(after, saved, counts);
        assert.deepEqual(after[APPROVED_VARIANTS] ?? [], []);
        assert.equal(counts.get('update') ?? 0, 0);
        assert.equal(importRequests, importRetry ? 2 : 1);
        assert.deepEqual(errors, []);
        t.diagnostic(
          `Actual native source/signed HTTP + upload intent/fixture PUT/real finalization -> ${scenario} -> explicit Keep and guarded draft save; current selection/order/capacity retained, no premature save or publish. No live COS claim.`,
        );
        return;
      }
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
      if (publishing) {
        try {
          if (scenario !== 'publish-review-required')
            await form.getByRole('button', { name: 'Keep website version', exact: true }).click();
          await form.locator('#published').check();
          await form.getByRole('button', { name: 'Save', exact: true }).click();
          if (scenario === 'publish-missing-category') {
            await expect(
              form.getByText('Choose a website category before publishing.', { exact: true }),
            ).toBeVisible();
            await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
            assert.deepEqual(await adapter.get('products', original._id), before.products[0]);
            assert.equal(counts.get('product-operation-start') ?? 0, 0);
            return;
          }
          if (scenario === 'publish-before-start') {
            await expect(
              form.getByRole('button', { name: 'Stop original publication', exact: true }),
            ).toBeEnabled();
            assert.deepEqual(await adapter.get('products', original._id), before.products[0]);
            await expect(form.locator('#description')).toBeDisabled();
            await form
              .getByRole('button', { name: 'Stop original publication', exact: true })
              .click();
            await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
            await expect(form.locator('#name')).toHaveValue(expectedName);
            await expect(form.locator('#description')).toHaveValue('My unsaved description');
            await form.locator('#published').uncheck();
            await form.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
            const product = await adapter.get('products', original._id);
            assert.equal(product?.name, expectedName);
            assert.equal(product?.published, false);
            assert.equal(counts.get('product-operation-start'), 2);
            assert.equal(counts.get('product-operation-stop'), 1);
            return;
          }
          if (scenario === 'publish-public-read' || scenario === 'publish-late-private-read') {
            await expect(
              form.getByRole('button', { name: 'Check publication', exact: true }),
            ).toBeEnabled({ timeout: 20000 });
            assert.equal((await adapter.get('products', original._id))?.published, true);
            await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            if (scenario === 'publish-late-private-read') {
              const renewed = await signSession(config.jwtSecret, {
                sub: 'admin',
                email: 'admin@example.test',
                name: 'Admin renewed',
                role: 'admin',
              });
              await page.evaluate(
                async ({ renewed, modulePath }) => {
                  const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
                    await import(modulePath);
                  harness.setEditorSession(renewed, 'admin');
                },
                {
                  renewed,
                  modulePath: '/src/islands/admin/testing/editor-recovery-browser-harness.tsx',
                },
              );
              await form
                .getByRole('button', { name: 'Reconnect original account', exact: true })
                .click();
              await expect(
                form.getByRole('button', { name: 'Check publication', exact: true }),
              ).toBeEnabled();
              await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            }
            await form.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(form).toBeVisible();
            await expect(page.getByText('Editor closed', { exact: true })).toHaveCount(0);
            publicBlocked = false;
            await form.getByRole('button', { name: 'Check publication', exact: true }).click();
            await expect(
              form.getByRole('button', { name: 'Open current product', exact: true }),
            ).toBeVisible();
            await expect(form.locator('#description')).toHaveValue('My unsaved description');
            await expect(
              form.getByRole('button', { name: 'Open current product', exact: true }),
            ).toBeDisabled();
            const download = page.waitForEvent('download');
            await form.getByRole('button', { name: 'Download current edits', exact: true }).click();
            const savedDownload = await download;
            const path = await savedDownload.path();
            assert.ok(path);
            assert.equal(
              JSON.parse(await readFile(path, 'utf8')).description,
              'My unsaved description',
            );
            await form.getByRole('button', { name: 'Open current product', exact: true }).click();
            await expect(form.locator('#name')).toHaveValue(expectedName);
            await expect(form.locator('#published')).toBeChecked();
            await expect(
              form.getByRole('button', { name: 'Open current product', exact: true }),
            ).toHaveCount(0);
            if (scenario === 'publish-late-private-read') assert.equal(latePrivateDropped, true);
          } else if (scenario === 'publish-review-required') {
            await expect(
              form.getByText(/Review the supplier change for Description/),
            ).toBeVisible();
            await expect(
              form.getByRole('button', { name: 'Stop original publication', exact: true }),
            ).toBeEnabled();
            assert.equal((await adapter.get('products', original._id))?.published, false);
            await form
              .getByRole('button', { name: 'Stop original publication', exact: true })
              .click();
            const download = page.waitForEvent('download');
            await form.getByRole('button', { name: 'Download current edits', exact: true }).click();
            await download;
            await form.getByRole('button', { name: 'Open current product', exact: true }).click();
            await expect(form.locator('#name')).toHaveValue(expectedName);
            await form.getByRole('button', { name: 'Keep website version', exact: true }).click();
            await form.locator('#published').check();
            await form.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(page.getByText('Product published', { exact: true })).toBeVisible({
              timeout: 20000,
            });
          } else {
            await expect(page.getByText('Product published', { exact: true })).toBeVisible({
              timeout: 20000,
            });
          }
          const product = await adapter.get('products', original._id);
          assert.ok(product);
          assert.equal(product.name, expectedName);
          assert.equal(product.description, 'My unsaved description');
          assert.equal(product.published, true);
          assert.equal(product.productFamily, 'misc');
          const receipt = z
            .object({ operationId: z.string().uuid() })
            .parse(product.catalogDetailApprovalReceipt);
          const after = JSON.parse(await readFile(file, 'utf8'));
          const roots = after[APPROVAL_JOBS].filter(
            (root: { operationId: string }) => root.operationId === receipt.operationId,
          );
          assert.equal(roots.length, 1);
          assert.equal(roots[0].state, 'complete');
          assert.equal(roots[0].operation.intent, 'publish');
          assert.equal(roots[0].operation.values.name, expectedName);
          assert.equal(roots[0].operation.values.published, undefined);
          assert.equal(
            counts.get('product-operation-start'),
            scenario === 'publish-review-required' ? 2 : 1,
          );
          assert.ok((counts.get('product-operation-continue') ?? 0) > 0);
          const result = await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${original._id}/detail` },
            { enableCatalogDetail: true },
          );
          assert.equal(result.statusCode, 200, result.body);
          const detail = decodeCatalogDetailView(JSON.parse(result.body).data);
          assert.ok(detail.ok);
          assert.equal(detail.value.name, expectedName);
          if (scenario === 'publish-lost-completion') assert.equal(saveReplyDropped, true);
        } catch (error) {
          console.log(
            'Owned publication diagnostic',
            scenario,
            JSON.stringify({
              requests: [...counts],
              form: await form.innerText().catch(() => 'closed'),
            }),
          );
          throw error;
        } finally {
          publicBlocked = false;
          assert.equal(counts.get('update') ?? 0, 0);
          for (const action of ['prepare', 'begin', 'page', 'finish'])
            assert.equal(counts.get(action) ?? 0, 0);
          const roots = JSON.parse(await readFile(file, 'utf8'))[APPROVAL_JOBS] ?? [];
          for (const root of roots)
            if (
              root.operation?.protocolVersion === 2 &&
              root.state !== 'complete' &&
              !root.operation.cancelledAt
            ) {
              const cancelled = await invoke(
                JSON.stringify({
                  action: 'catalogDetailApproval',
                  token,
                  data: {
                    action: 'product-operation-cancel',
                    productId: original._id,
                    operationId: root.operationId,
                    inputDigest: root.operation.inputDigest,
                  },
                }),
              );
              assert.equal(cancelled.statusCode, 200, cancelled.body);
            }
          const current = await adapter.get('products', original._id);
          if (current?.published) {
            const withdrawn = await invoke(
              JSON.stringify({
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id: original._id,
                  values: { published: false },
                  expectedUpdatedAt: current.updatedAt,
                },
              }),
            );
            assert.equal(withdrawn.statusCode, 200, withdrawn.body);
            assert.equal(JSON.parse(withdrawn.body).ok, true, withdrawn.body);
          }
          const withdrawnPublic = await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${original._id}/detail` },
            { enableCatalogDetail: true },
          );
          assert.equal(withdrawnPublic.statusCode, 404, withdrawnPublic.body);
          const reference = await adapter.readCatalogImageReference({
            action: 'read',
            imageId: 'editor-publication-photo',
          });
          assert.ok(reference.state === 'counted' && reference.effectiveCount === 0);
          assert.deepEqual(errors, []);
        }
        return;
      }
      if (scenario === 'session-reconnect') {
        const changeSession = async (sessionToken: string, actorId: string) =>
          page.evaluate(
            async ({ sessionToken, actorId, modulePath }) => {
              const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
                await import(modulePath);
              harness.setEditorSession(sessionToken, actorId);
            },
            {
              sessionToken,
              actorId,
              modulePath: '/src/islands/admin/testing/editor-recovery-browser-harness.tsx',
            },
          );
        await changeSession(token, 'another-admin');
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await form.getByRole('button', { name: 'Reconnect original account', exact: true }).click();
        await expect(
          form.getByText(
            'Return to the original account and API environment to reconnect this form.',
            { exact: true },
          ),
        ).toBeVisible();
        assert.equal(counts.get('product-operation-start') ?? 0, 0);
        const renewed = await signSession(config.jwtSecret, {
          sub: 'admin',
          email: 'admin@example.test',
          name: 'Admin renewed',
          role: 'admin',
        });
        await changeSession(renewed, 'admin');
        await form.getByRole('button', { name: 'Reconnect original account', exact: true }).click();
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        await expect(form.locator('#name')).toHaveValue(expectedName);
        await expect(form.locator('#description')).toHaveValue('My unsaved description');
      }
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      if (scenario === 'start-before-lost') {
        await expect(
          form.getByRole('button', { name: 'Stop original save', exact: true }),
        ).toBeEnabled();
        assert.deepEqual(await adapter.get('products', original._id), before.products[0]);
        await expect(form.locator('#description')).toBeDisabled();
        await expect(form.locator('#description')).toHaveValue('My unsaved description');
        await form.getByRole('button', { name: 'Stop original save', exact: true }).click();
        await expect(
          form.getByRole('button', { name: 'Keep editing this draft', exact: true }),
        ).toBeEnabled();
        await form.getByRole('button', { name: 'Keep editing this draft', exact: true }).click();
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        await expect(form.locator('#description')).toHaveValue('My unsaved description');
        await form.locator('#description').fill('Later edits survive stopping');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
        const after = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(after.products[0].description, 'Later edits survive stopping');
        assert.equal(after.products[0].published, false);
        assert.equal(after[APPROVAL_JOBS].length, 2);
        assert.equal(
          after[APPROVAL_JOBS].filter(
            (root: { operation: { cancelledAt?: string } }) => root.operation.cancelledAt,
          ).length,
          1,
        );
        assert.equal(counts.get('product-operation-start'), 2);
        assert.equal(counts.get('product-operation-save'), 1);
        assert.equal(counts.get('product-operation-stop'), 1);
        assert.equal(counts.get('update') ?? 0, 0);
        assert.deepEqual(errors, []);
        return;
      }
      if (['save-and-check-lost', 'multiple-original-saves'].includes(scenario)) {
        await expect(
          form.getByRole('button', { name: 'Check original save', exact: true }),
        ).toBeEnabled();
        await expect(form.locator('#description')).toBeDisabled();
        await expect(form.locator('#description')).toHaveValue('My unsaved description');
        const originallySaved = await adapter.get('products', original._id);
        assert.ok(originallySaved);
        const independentEdit = await invoke(
          JSON.stringify({
            action: 'update',
            token,
            data: {
              collection: 'products',
              id: original._id,
              values: { description: 'Other administrator newer edit' },
              expectedUpdatedAt: originallySaved.updatedAt,
            },
          }),
        );
        assert.equal(independentEdit.statusCode, 200, independentEdit.body);
        if (scenario === 'multiple-original-saves') {
          const current = await adapter.get('products', original._id);
          assert.ok(current);
          const second = await invoke(
            JSON.stringify({
              action: 'catalogDetailApproval',
              token,
              data: {
                action: 'product-operation-start',
                intent: 'save-draft',
                productId: original._id,
                operationId: crypto.randomUUID(),
                expectedUpdatedAt: current.updatedAt,
                values: { description: 'Other original save not committed' },
              },
            }),
          );
          assert.equal(second.statusCode, 200, second.body);
          const scope = z
            .object({ productId: z.string(), operationId: z.string(), inputDigest: z.string() })
            .parse(JSON.parse(second.body).data);
          await page.evaluate(
            async ({ scope, modulePath }) => {
              const harness: typeof import('./testing/editor-recovery-browser-harness.tsx') =
                await import(modulePath);
              harness.retainOriginalDraftSave(scope);
            },
            { scope, modulePath: '/src/islands/admin/testing/editor-recovery-browser-harness.tsx' },
          );
        }
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(form).toBeVisible();
        await expect(
          form.getByText(/Check or stop the original save before closing/),
        ).toBeVisible();
        blockSaveConfirmation = false;
        await form.getByRole('button', { name: 'Check original save', exact: true }).click();
        await expect(
          form.getByText(
            'The original save is historical. Download your edits before opening the current product.',
            { exact: true },
          ),
        ).toBeVisible();
        await expect(form.locator('#description')).toHaveValue('My unsaved description');
        const open = form.getByRole('button', { name: 'Open saved product', exact: true });
        if (scenario === 'multiple-original-saves') {
          const width = await form
            .locator('[data-record-form-body]')
            .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
          assert.ok(width.scroll <= width.client + 1, JSON.stringify(width));
          const directory = fileURLToPath(
            new URL(
              '../../../../../output/pricing-clock-repair-2026-10-13/p3e1/draft-editor-mobile/',
              import.meta.url,
            ),
          );
          await mkdir(directory, { recursive: true });
          await form.locator('[data-record-form-body]').evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.screenshot({ path: join(directory, `${engine}-multiple-original-saves.png`) });
        }
        await expect(open).toBeDisabled();
        const downloaded = page.waitForEvent('download');
        await form.getByRole('button', { name: 'Download current edits', exact: true }).click();
        const path = await (await downloaded).path();
        assert.ok(path);
        const backup = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(backup.description, 'My unsaved description');
        assert.doesNotMatch(JSON.stringify(backup), /channel\.token|Bearer |eyJhbGci/);
        await expect(open).toBeEnabled();
        await open.click();
        if (scenario === 'multiple-original-saves') {
          await expect(
            form.getByText('Resolve the remaining original saves before reopening this product.', {
              exact: true,
            }),
          ).toBeVisible();
          await expect(open).toHaveCount(0);
          await expect(form.locator('#description')).toHaveValue('My unsaved description');
          await form.getByRole('button', { name: 'Stop original save', exact: true }).click();
          await expect(
            form.getByText('The original save is stopped. Saved product changes have been kept.', {
              exact: true,
            }),
          ).toBeVisible();
          await form.getByRole('button', { name: 'Open saved product', exact: true }).click();
        }
        await expect(form.locator('#description')).toHaveValue('Other administrator newer edit');
        await expect(form.locator('#name')).toHaveValue(expectedName);
        const rows = JSON.parse(await readFile(file, 'utf8'));
        if (scenario === 'multiple-original-saves') {
          assert.equal(rows[APPROVAL_JOBS].length, 2);
          const cancelled = rows[APPROVAL_JOBS].filter(
            (row: { state: string }) => row.state === 'reserved',
          );
          assert.equal(cancelled.length, 1);
          assert.ok(cancelled[0].operation.cancelledAt);
          assert.equal(counts.get('product-operation-stop') ?? 0, 0);
          assert.equal(counts.get('product-operation-cancel'), 1);
          rows[APPROVAL_JOBS] = rows[APPROVAL_JOBS].filter(
            (row: { state: string }) => row.state === 'saved',
          );
        }
        assertOriginalDraftSave(rows, originallySaved, counts);
        assert.equal(
          await page.evaluate(
            () =>
              Object.keys(localStorage).filter((key) => key.startsWith('channel:draft:')).length,
          ),
          0,
        );
        assert.deepEqual(errors, []);
        return;
      }
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
      assertOriginalDraftSave(after, saved, counts);
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
      assert.equal(counts.get('update') ?? 0, 0);
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

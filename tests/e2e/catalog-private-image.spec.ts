import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { largeCatalogPng } from '../../packages/media-storage/src/catalog-image-fixtures.test-helper.ts';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireAdminCredentialsWhenEnabled } from './helpers/env';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

test('private large image: real UI upload, backend preview, same-id replay and exact cleanup', async ({
  page,
  request,
}) => {
  test.skip(!e2e.catalogPrivateImageSmoke, 'Set E2E_CATALOG_PRIVATE_IMAGE_SMOKE=1.');
  // Two bounded transfers exercise the existing user retry; each PUT stays at five minutes.
  test.setTimeout(840_000);
  requireAdminCredentialsWhenEnabled(true, 'Private image acceptance');
  const release = process.env.CHANNEL_EXPECTED_RELEASE ?? '';
  expect(release, 'An exact accepted program is required before writing the fixture.').toMatch(
    /^[a-f0-9]{40}$/,
  );
  expect(new URL(e2e.siteUrl).origin).toBe('https://supplychainsai.com');
  expect([
    'https://supplychainsai.com',
    'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com',
  ]).toContain(new URL(e2e.apiUrl).origin);
  const session = await loginAdmin(request);
  expect(session.user.role).toBe('admin');
  const health = await adminAction<{ releaseId: string; deployedReleaseId?: string }>(
    request,
    'health',
  );
  expect(health.releaseId === release || health.deployedReleaseId === release).toBe(true);
  const bytes = await largeCatalogPng();
  expect(bytes.length).toBeGreaterThan(4_500_000);
  const checksum = hash(bytes);
  const name = `${e2e.runId}-large-private.png`;
  const list = () =>
    adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      {
        collection: 'images',
        page: 1,
        pageSize: 10,
        filter: { combinator: 'and', clauses: [{ field: 'name', op: 'eq', value: name }] },
      },
      session.token,
    );
  expect((await list()).items).toHaveLength(0);
  const receipt: Record<string, unknown> = { release, name, originalBytes: bytes.length, checksum };
  const abandon = async (imageId: string): Promise<{ deleted: boolean }> => {
    const started = Date.now();
    try {
      const result = await adminAction<{ deleted: boolean }>(
        request,
        'abandonUpload',
        { imageId },
        session.token,
        { timeoutMs: 60_000 },
      );
      receipt.cleanupReply = 'confirmed';
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('abandonUpload failed')) throw error;
      receipt.cleanupReply = 'unknown';
      // Never repeat a delete after a lost reply. Read this exact operation's result twice at most.
      for (let readback = 0; readback < 2; readback++) {
        if (readback) await new Promise((resolve) => setTimeout(resolve, 2000));
        receipt.cleanupWaitReads = readback + 1;
        const afterUnknown = await list().catch(() => null);
        if (afterUnknown && !afterUnknown.items.some((row) => row._id === imageId)) {
          receipt.cleanupConfirmedByReadback = true;
          return { deleted: true };
        }
      }
      throw error;
    } finally {
      receipt.cleanupElapsedMs = Date.now() - started;
    }
  };
  await mkdir('output/catalog-private-image', { recursive: true });
  let putCount = 0;
  let retryAttempts = 0;
  let droppedStorageStatus: number | undefined;
  let faultInjectionFailed = false;
  const putDestinations = new Set<string>();
  let failure: unknown;
  let cleanupFailure: unknown;
  const uploadTransport: Array<Record<string, unknown>> = [];
  const uploadStarts = new Map<string, number>();
  const errorReads = new Set<Promise<void>>();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  const storageRequests = new Set<string>();
  const uploadNetwork: Array<Record<string, unknown>> = [];
  network.on('Network.requestWillBeSent', ({ requestId, request: outgoing }) => {
    const url = new URL(outgoing.url);
    if (outgoing.method === 'PUT' && url.hostname.endsWith('.myqcloud.com'))
      storageRequests.add(requestId);
  });
  network.on('Network.responseReceived', ({ requestId, response }) => {
    if (!storageRequests.has(requestId)) return;
    const timing = response.timing;
    uploadNetwork.push({
      status: response.status,
      protocol: response.protocol,
      timing: timing
        ? Object.fromEntries(
            [
              'dnsStart',
              'dnsEnd',
              'connectStart',
              'connectEnd',
              'sslStart',
              'sslEnd',
              'sendStart',
              'sendEnd',
              'receiveHeadersStart',
            ].map((key) => [key, Reflect.get(timing, key)]),
          )
        : null,
    });
  });
  page.on('response', (response) => {
    const req = response.request();
    if (req.method() === 'PUT') {
      const observed: Record<string, unknown> = {
        host: new URL(req.url()).hostname,
        status: response.status(),
        elapsedMs: Date.now() - (uploadStarts.get(req.url()) ?? Date.now()),
      };
      uploadTransport.push(observed);
      if (response.status() >= 400) {
        const read = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const body = await Promise.race([
              response.text(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(Error('Storage error body unavailable')), 2000);
              }),
            ]);
            // Preserve only a provider error code, never signed URLs, headers or raw XML.
            observed.storageErrorCode =
              body.length <= 65_536
                ? (/<Code>([A-Za-z0-9_.-]{1,80})<\/Code>/.exec(body)?.[1] ?? null)
                : null;
          } catch {
            observed.storageErrorBodyUnavailable = true;
          } finally {
            if (timer) clearTimeout(timer);
          }
        })();
        errorReads.add(read);
        void read.finally(() => errorReads.delete(read));
      }
    }
  });
  page.on('requestfailed', (req) => {
    if (req.method() === 'PUT')
      uploadTransport.push({
        host: new URL(req.url()).hostname,
        error: req.failure()?.errorText,
        elapsedMs: Date.now() - (uploadStarts.get(req.url()) ?? Date.now()),
      });
  });
  const unexpectedUiActions = new Set<string>();
  const uiAdminRequestCounts = new Map<string, number>();
  const readAndUploadActions = new Set([
    'login',
    'me',
    'get',
    'list',
    'inquiryCapabilities',
    'catalogDetailCapabilities',
    'productReviewSummary',
    'createUploadIntent',
    'completeUpload',
    'getImagePreview',
  ]);
  page.on('request', (req) => {
    if (req.method() === 'PUT') uploadStarts.set(req.url(), Date.now());
    if (req.method() === 'PUT') {
      const target = new URL(req.url());
      if (target.hostname.endsWith('.myqcloud.com')) {
        putCount++;
        putDestinations.add(target.origin + target.pathname);
      }
    }
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/admin') {
      try {
        const body: unknown = req.postDataJSON();
        if (!body || typeof body !== 'object' || !('action' in body)) {
          unexpectedUiActions.add('unreadable-admin-request');
          return;
        }
        const action = String(body.action);
        uiAdminRequestCounts.set(action, (uiAdminRequestCounts.get(action) ?? 0) + 1);
        const data = 'data' in body && body.data && typeof body.data === 'object' ? body.data : {};
        if (action === 'inquiry' && 'action' in data && data.action === 'list') return;
        if (action === 'catalogCategories' && 'operation' in data && data.operation === 'read')
          return;
        if (!readAndUploadActions.has(action)) unexpectedUiActions.add(action);
      } catch {
        unexpectedUiActions.add('unreadable-admin-request');
      }
    }
  });
  try {
    await page.goto('/login?returnTo=/admin', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/admin(?:$|\?)/);
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^New / }).click();
    const gallery = page.locator('[data-image-manager="gallery"]');
    if (e2e.catalogPrivateImageDropReply) {
      // Let Chromium send the real PUT. Hide only the first successful storage response.
      network.on('Fetch.requestPaused', ({ requestId, request: paused, responseStatusCode }) => {
        const continueRequest = () => network.send('Fetch.continueRequest', { requestId });
        if (
          droppedStorageStatus === undefined &&
          paused.method === 'PUT' &&
          responseStatusCode !== undefined &&
          responseStatusCode >= 200 &&
          responseStatusCode < 300
        ) {
          droppedStorageStatus = responseStatusCode;
          void network
            .send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' })
            .catch(async () => {
              faultInjectionFailed = true;
              await continueRequest().catch(() => {});
            });
        } else {
          void continueRequest().catch(() => {
            faultInjectionFailed = true;
          });
        }
      });
      await network.send('Fetch.enable', {
        patterns: [{ urlPattern: 'https://*.myqcloud.com/*', requestStage: 'Response' }],
      });
    }
    await gallery.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: bytes,
    });
    const uploadState = async () =>
      (await gallery.locator('[data-image-id]').count()) === 1
        ? 'ready'
        : (await gallery.getByRole('button', { name: 'Retry', exact: true }).isVisible())
          ? 'failed'
          : 'pending';
    const waitForUpload = async () => {
      // Finish immediately on the real UI failure instead of waiting out a readiness assertion.
      await expect.poll(uploadState, { timeout: 360_000 }).not.toBe('pending');
    };
    await waitForUpload();
    if ((await uploadState()) === 'failed') {
      receipt.firstUploadFailure = (await gallery.innerText()).slice(0, 1200);
      retryAttempts++;
      await gallery.getByRole('button', { name: 'Retry', exact: true }).click();
      await waitForUpload();
    }
    await expect(gallery.locator('[data-image-id]')).toHaveCount(1);
    await expect(gallery.getByText('Failed — retry')).toHaveCount(0);
    await expect(gallery.locator('img')).toBeVisible();
    const imageId = await gallery.locator('[data-image-id]').getAttribute('data-image-id');
    expect(imageId).toBeTruthy();
    const uploaded = await list();
    expect(uploaded.items).toHaveLength(1);
    const image = uploaded.items[0];
    if (!image) throw new Error('Uploaded image is missing from its exact-name lookup.');
    expect(image?._id).toBe(imageId);
    expect(image?.status).toBe('active');
    expect(image?.byteSize).toBe(bytes.length);
    expect(image?.checksumSha256).toBe(checksum);
    expect(image?.publishedRefCount).toBe(0);
    const web = record(image?.catalogWebImage);
    expect(web.schemaVersion).toBe(1);
    expect(web.mimeType).toBe('image/webp');
    expect(web.width).toBe(1280);
    expect(web.height).toBe(800);
    expect(web.byteSize).toEqual(expect.any(Number));
    expect(Number(web.byteSize)).toBeLessThan(3_000_000);
    const variants = record(image.catalogWebVariants);
    const responsive = [160, 640].map((width) => {
      const variant = record(variants[String(width)]);
      expect(variant.width).toBe(width);
      expect(variant.height).toBe((width * 1000) / 1600);
      expect(variant.mimeType).toBe('image/webp');
      return variant;
    });
    const objects = [
      { storageFileId: image.storageFileId, storagePath: image.storagePath },
      { storageFileId: web.storageFileId, storagePath: web.storagePath },
      ...responsive.map((variant) => ({
        storageFileId: variant.storageFileId,
        storagePath: variant.storagePath,
      })),
    ];
    for (const object of objects) {
      expect(typeof object.storageFileId).toBe('string');
      expect(typeof object.storagePath).toBe('string');
    }
    expect(new Set(objects.map((object) => object.storageFileId)).size).toBe(4);
    receipt.objects = objects;
    const preview = await adminAction<{ mimeType: string; dataBase64: string }>(
      request,
      'getImagePreview',
      { id: imageId },
      session.token,
    );
    expect(preview.mimeType).toBe('image/webp');
    const previewBytes = Buffer.from(preview.dataBase64, 'base64');
    expect(previewBytes.length).toBe(web.byteSize);
    expect(hash(previewBytes)).toBe(web.checksumSha256);
    const decoded = await page.evaluate(
      async ({ base64, mimeType }) => {
        const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([buffer], { type: mimeType }));
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      },
      { base64: preview.dataBase64, mimeType: preview.mimeType },
    );
    expect(decoded).toEqual({ width: 1280, height: 800 });
    for (let replay = 0; replay < 2; replay++) {
      const result = await adminAction<{ imageId: string; image: CollectionDoc }>(
        request,
        'completeUpload',
        { imageId },
        session.token,
      );
      expect(result.imageId).toBe(imageId);
      expect(result.image._id).toBe(imageId);
      expect(result.image.status).toBe('active');
      expect(result.image.catalogWebImage).toEqual(web);
      expect(result.image.catalogWebVariants).toEqual(variants);
      expect(result.image.uploadedByUserId).toBeUndefined();
      expect(result.image.imageMutationOwner).toBeUndefined();
    }
    const replayed = await list();
    expect(replayed.items).toHaveLength(1);
    expect(replayed.items[0]?.catalogWebImage).toEqual(web);
    expect(replayed.items[0]?.catalogWebVariants).toEqual(variants);
    expect(putCount).toBe(1 + retryAttempts);
    if (e2e.catalogPrivateImageDropReply) {
      expect(faultInjectionFailed).toBe(false);
      expect(droppedStorageStatus).toBeGreaterThanOrEqual(200);
      expect(retryAttempts).toBe(1);
      expect(putDestinations.size).toBe(1);
    }
    expect(uiAdminRequestCounts.get('createUploadIntent')).toBe(1);
    const anonymous = await request.get(`${e2e.apiUrl}/api/images/${imageId}`);
    expect(anonymous.status()).toBe(404);
    const privateDenied = await request.post(`${e2e.apiUrl}/api/admin`, {
      data: { action: 'getImagePreview', data: { id: imageId }, token: '' },
    });
    expect(privateDenied.status()).toBe(401);
    expect([...unexpectedUiActions], 'The UI must not request product writes.').toEqual([]);
    await page.screenshot({ path: 'output/catalog-private-image/private-upload.png' });
    Object.assign(receipt, {
      imageId,
      sourceHashMatches: true,
      previewHashMatches: true,
      previewBytes: previewBytes.length,
      previewDimensions: decoded,
      completeReplays: 2,
      imageRecords: 1,
      cosPuts: putCount,
      userRetryAttempts: retryAttempts,
      anonymousStatus: 404,
      unauthenticatedPreviewStatus: 401,
      productsCreated: 0,
      productsPublished: 0,
      backendPreviewDecoded: true,
      uiPersistedReopenTested: false,
      passed: true,
    });
  } catch (error) {
    failure = error;
    receipt.passed = false;
    receipt.error = error instanceof Error ? error.message : 'Acceptance failed';
    const gallery = page.locator('[data-image-manager="gallery"]');
    if (await gallery.isVisible().catch(() => false)) {
      receipt.uploadMessage = (await gallery.innerText()).slice(0, 1200);
      await page
        .screenshot({ path: 'output/catalog-private-image/private-upload-failed.png' })
        .catch(() => {});
    }
  } finally {
    try {
      const remaining = await list();
      expect(remaining.items.length).toBeLessThanOrEqual(2);
      receipt.cleanupImageIds = remaining.items.map((image) => image._id);
      for (const image of remaining.items) {
        expect(image.name).toBe(name);
        expect(image.byteSize).toBe(bytes.length);
        expect(
          image.status !== 'pending' ||
            droppedStorageStatus !== undefined ||
            uploadTransport.some(
              (result) =>
                typeof result.status === 'number' && result.status >= 200 && result.status < 300,
            ),
          `Incomplete private upload ${image._id} needs scoped cleanup after confirming storage state; no product was created.`,
        ).toBe(true);
        if (image.status === 'pending')
          await adminAction(request, 'completeUpload', { imageId: image._id }, session.token);
        // The list hides uploader identity; abandonUpload rechecks it server-side.
        // Never add an image to a product just to make its cleanup possible.
        const cleaned = await abandon(image._id);
        expect(cleaned.deleted).toBe(true);
      }
      expect((await list()).items).toHaveLength(0);
      receipt.cleaned = true;
    } catch (error) {
      receipt.cleaned = false;
      receipt.passed = false;
      receipt.cleanupError = error instanceof Error ? error.message : 'Cleanup unconfirmed';
      cleanupFailure = error;
    } finally {
      await Promise.allSettled([...errorReads]);
      receipt.uploadTransport = uploadTransport;
      if (e2e.catalogPrivateImageDropReply) {
        receipt.droppedStorageStatus = droppedStorageStatus ?? null;
        receipt.faultInjectionFailed = faultInjectionFailed;
        receipt.distinctPutDestinations = putDestinations.size;
      }
      receipt.uploadNetwork = uploadNetwork;
      receipt.userRetryAttempts = retryAttempts;
      receipt.uiAdminRequestCounts = Object.fromEntries(uiAdminRequestCounts);
      receipt.unexpectedUiActions = [...unexpectedUiActions];
      await writeFile('output/catalog-private-image/result.json', JSON.stringify(receipt, null, 2));
    }
  }
  if (failure && cleanupFailure)
    throw new AggregateError([failure, cleanupFailure], 'Acceptance and exact cleanup failed');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
});

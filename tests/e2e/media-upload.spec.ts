import { Buffer } from 'node:buffer';
import { type Page, expect, test } from '@playwright/test';
import { type CollectionDoc, adminAction } from './helpers/admin-api';
import { e2e, hasAdminCredentials } from './helpers/env';

test.describe.configure({ mode: 'serial' });

interface BrowserAdminSession {
  token: string;
  user: { id: string; email: string; username: string; role: string };
}

interface UploadIntent {
  imageId: string;
  uploadIntentId: string;
  storageFileId: string;
  upload: { url: string; headers: Record<string, string> };
}

interface ImagePreview {
  id: string;
  mimeType: string;
  dataBase64: string;
}

interface BrowserFetchResult {
  status: number;
  contentType: string;
  bodySnippet: string;
}

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: { code: string; message: string };
}

type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiErrorMessage(value: unknown): string {
  if (!isRecord(value)) return 'Unknown API response';
  const error = value.error;
  if (!isRecord(error)) return 'Unknown API error';
  return typeof error.message === 'string' ? error.message : 'Unknown API error';
}

async function browserAdminAction<T>(
  page: Page,
  action: string,
  data?: unknown,
  token = '',
): Promise<T> {
  return page.evaluate(
    async ({ apiUrl, actionName, payload, sessionToken }) => {
      const response = await fetch(`${apiUrl}/api/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionName, data: payload, token: sessionToken }),
      });
      const json = (await response.json()) as ApiEnvelope<T>;
      if (!response.ok || !json.ok) {
        const message =
          !json.ok && json.error?.message ? json.error.message : `HTTP ${response.status}`;
        throw new Error(`${actionName} failed: ${message}`);
      }
      return json.data;
    },
    { apiUrl: e2e.apiUrl, actionName: action, payload: data, sessionToken: token },
  );
}

async function browserFetchStatus(
  page: Page,
  url: string,
  headers?: Record<string, string>,
): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ targetUrl, requestHeaders }) => {
      const response = await fetch(
        targetUrl,
        requestHeaders ? { headers: requestHeaders } : undefined,
      );
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bodySnippet: text.slice(0, 120),
      };
    },
    { targetUrl: url, requestHeaders: headers },
  );
}

async function browserPutObject(page: Page, intent: UploadIntent): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ uploadUrl, headers, bodyBase64 }) => {
      const raw = atob(bodyBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: new Blob([bytes], { type: 'image/png' }),
      });
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bodySnippet: text.slice(0, 120),
      };
    },
    {
      uploadUrl: intent.upload.url,
      headers: intent.upload.headers,
      bodyBase64: onePixelPng.toString('base64'),
    },
  );
}

test.describe('MIU-09 deployed media upload smoke', () => {
  test.skip(
    !e2e.mediaUploadSmoke || !hasAdminCredentials(),
    'Set E2E_MEDIA_UPLOAD_SMOKE=1 plus E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD to run the deployed media upload smoke.',
  );

  test('browser origin uploads to COS, admin previews privately, and public delivery is refcount-gated', async ({
    page,
    request,
  }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    let token = '';
    let imageId = '';
    let productId = '';

    try {
      const session = await browserAdminAction<BrowserAdminSession>(page, 'login', {
        email: e2e.adminEmail,
        password: e2e.adminPassword,
      });
      token = session.token;
      expect(['admin', 'contributor']).toContain(session.user.role);

      const fileName = `${e2e.runId}-miu09.png`;
      const intent = await browserAdminAction<UploadIntent>(
        page,
        'createUploadIntent',
        {
          fileName,
          mimeType: 'image/png',
          byteSize: onePixelPng.byteLength,
        },
        token,
      );
      imageId = intent.imageId;
      expect(intent.upload.url).toMatch(/^https:\/\//);
      expect(intent.upload.headers.Authorization).toBeTruthy();
      expect(intent.upload.headers['X-Cos-Security-Token']).toBeTruthy();
      expect(intent.upload.headers['X-Cos-Meta-Fileid']).toBeTruthy();

      const put = await browserPutObject(page, intent);
      expect(put.status, `COS PUT failed: ${put.bodySnippet}`).toBeGreaterThanOrEqual(200);
      expect(put.status, `COS PUT failed: ${put.bodySnippet}`).toBeLessThan(300);

      await browserAdminAction(page, 'completeUpload', { imageId }, token);

      const preview = await browserAdminAction<ImagePreview>(
        page,
        'getImagePreview',
        { id: imageId },
        token,
      );
      expect(preview.id).toBe(imageId);
      expect(preview.mimeType).toBe('image/png');
      expect(Buffer.from(preview.dataBase64, 'base64').byteLength).toBe(onePixelPng.byteLength);

      const unpublished = await browserFetchStatus(
        page,
        `${e2e.apiUrl}/api/images/${encodeURIComponent(imageId)}`,
      );
      expect(unpublished.status).toBe(404);

      const product = await browserAdminAction<CollectionDoc>(
        page,
        'create',
        {
          collection: 'products',
          values: {
            name: `${e2e.runId} MIU-09 Upload Smoke`,
            category: 'wired',
            series: 'MIU-09',
            modName: 'Storage Upload Smoke',
            modType: 'Browser PUT',
            description: 'Created by MIU-09 media upload smoke and removed during cleanup.',
            moq: 1,
            unitPrice: 1,
            wholesalePrice: 1,
            vipPrice: 1,
            imageIds: [imageId],
            published: true,
          },
        },
        token,
      );
      productId = product._id;

      await expect
        .poll(async () => {
          const response = await browserFetchStatus(
            page,
            `${e2e.apiUrl}/api/images/${encodeURIComponent(imageId)}`,
          );
          return response.status === 200 && response.contentType.includes('image/png');
        })
        .toBe(true);
    } finally {
      if (productId && token) {
        await adminAction<{ deleted: boolean }>(
          request,
          'remove',
          { collection: 'products', id: productId },
          token,
        ).catch((error: unknown) => {
          console.warn(`MIU-09 cleanup: product remove failed: ${apiErrorMessage(error)}`);
        });
      }
      if (imageId && token) {
        await adminAction<{ deleted: boolean }>(
          request,
          'remove',
          { collection: 'images', id: imageId },
          token,
        ).catch((error: unknown) => {
          console.warn(`MIU-09 cleanup: image metadata remove failed: ${apiErrorMessage(error)}`);
        });
      }
    }
  });
});

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
  upload: { method: 'PUT'; url: string; headers: Record<string, string> };
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

type ApproveOnce =
  | { ok: true; status: 'approved' }
  | { ok: true; status: 'needs-browser'; reason: string };

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
    async ({ uploadUrl, method, headers, bodyBase64 }) => {
      const raw = atob(bodyBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      // Raw PUT with credential headers — the shape @cloudbase/node-sdk 3.x
      // signs for. A multipart POST here returns 403 SignatureDoesNotMatch.
      const response = await fetch(uploadUrl, {
        method,
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
      method: intent.upload.method,
      headers: intent.upload.headers,
      bodyBase64: onePixelPng.toString('base64'),
    },
  );
}

test.describe('MIU-09 deployed media upload smoke', () => {
  test.skip(
    !e2e.mediaUploadSmoke,
    'Set E2E_MEDIA_UPLOAD_SMOKE=1 to run the deployed media upload smoke.',
  );

  test('browser origin uploads to COS, admin previews privately, and public delivery is refcount-gated', async ({
    page,
    request,
  }) => {
    if (!hasAdminCredentials()) {
      throw new Error(
        'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required when E2E_MEDIA_UPLOAD_SMOKE=1.',
      );
    }

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
      // Publishing is an approval, which only an admin may give (MIU-37).
      expect(session.user.role).toBe('admin');

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
      expect(intent.upload.method).toBe('PUT');
      expect(intent.upload.headers.Signature).toBeTruthy();
      expect(intent.upload.headers['x-cos-security-token']).toBeTruthy();
      expect(intent.upload.headers['x-cos-meta-fileid']).toBeTruthy();
      expect(intent.upload.headers.key).toBeTruthy();
      expect(intent.upload.headers.authorization).toBeTruthy();

      const post = await browserPutObject(page, intent);
      expect(post.status, `COS PUT failed: ${post.bodySnippet}`).toBeGreaterThanOrEqual(200);
      expect(post.status, `COS PUT failed: ${post.bodySnippet}`).toBeLessThan(300);

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

      // A new product starts as a draft; publishing it is an approval, the
      // same steps the admin page takes (create draft → approve → publish).
      const draft = await browserAdminAction<CollectionDoc>(
        page,
        'create',
        {
          collection: 'products',
          values: {
            name: `${e2e.runId} MIU-09 Upload Smoke`,
            productFamily: 'headphones',
            series: 'MIU-09',
            modName: 'Storage Upload Smoke',
            modType: 'Browser PUT',
            description: 'Created by MIU-09 media upload smoke and archived during cleanup.',
            moq: 1,
            unitPrice: 1,
            wholesalePrice: 1,
            imageIds: [imageId],
            published: false,
          },
        },
        token,
      );
      productId = draft._id;
      const capabilities = await browserAdminAction<{ enabled: boolean }>(
        page,
        'catalogDetailCapabilities',
        undefined,
        token,
      );
      if (capabilities.enabled) {
        const approval = await browserAdminAction<ApproveOnce>(
          page,
          'catalogDetailApproval',
          { action: 'approve', productId, operationId: crypto.randomUUID() },
          token,
        );
        expect(approval.status, 'a one-image manual product approves in one request').toBe(
          'approved',
        );
      }
      await browserAdminAction<CollectionDoc>(
        page,
        'update',
        { collection: 'products', id: productId, values: { published: true } },
        token,
      );

      await expect
        .poll(
          async () => {
            const response = await browserFetchStatus(
              page,
              `${e2e.apiUrl}/api/images/${encodeURIComponent(imageId)}`,
            );
            return response.status === 200 && response.contentType.includes('image/png');
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    } finally {
      // Products are archived, never deleted (archiving also unpublishes). The
      // archived product keeps its 1x1 image; an image no product used is
      // abandoned through the upload flow, the only way images are removed.
      if (productId && token) {
        await adminAction<CollectionDoc>(
          request,
          'update',
          { collection: 'products', id: productId, values: { archived: true } },
          token,
        ).catch((error: unknown) => {
          console.warn(`MIU-09 cleanup: product archive failed: ${apiErrorMessage(error)}`);
        });
      } else if (imageId && token) {
        await adminAction<{ deleted: boolean }>(request, 'abandonUpload', { imageId }, token).catch(
          (error: unknown) => {
            console.warn(`MIU-09 cleanup: image abandon failed: ${apiErrorMessage(error)}`);
          },
        );
      }
    }
  });
});

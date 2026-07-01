import { Buffer } from 'node:buffer';
import { type Page, expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, hasAdminCredentials } from './helpers/env';

/**
 * MIU-09 admin-UI upload e2e (real ImageManager, deployed env).
 *
 * Complements the API-level `media-upload.spec.ts` (which drives the upload
 * contract via `page.evaluate`) by exercising the ACTUAL admin experience in a real
 * Chromium page: a browser-origin login through the AuthForm, opening a catalog
 * record form, picking a file through the hidden `ImageManager` file input, and
 * asserting the upload completes and the image previews. Bytes still go
 * browser → COS directly (multipart POST); this proves the React `ImageManager` +
 * `api.ts` wiring works end-to-end against the deployed site, not just the contract.
 */
test.describe.configure({ mode: 'serial' });

// 1x1 transparent PNG (same fixture as the API-level smoke).
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

/** Sign in through the real AuthForm and land on the admin dashboard. */
async function uiLogin(page: Page): Promise<void> {
  await page.goto('/login?returnTo=/admin', { waitUntil: 'domcontentloaded' });
  await page.locator('astro-island[component-export="AuthForm"]:not([ssr])').waitFor();
  await page.getByLabel('Email').fill(e2e.adminEmail);
  await page.getByLabel('Password').fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin(?:$|\?)/);
}

test.describe('MIU-09 admin UI upload (ImageManager) — deployed env', () => {
  // Skip ONLY when the smoke is not enabled. When it IS enabled, missing creds must
  // FAIL (below), never silently skip — same fail-fast rule as media-upload.spec.ts.
  test.skip(
    !e2e.mediaUploadSmoke,
    'Set E2E_MEDIA_UPLOAD_SMOKE=1 to run the deployed UI upload test.',
  );

  test('an admin uploads an image through the ImageManager UI and it previews', async ({
    page,
    request,
  }) => {
    if (!hasAdminCredentials()) {
      throw new Error(
        'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required when E2E_MEDIA_UPLOAD_SMOKE=1.',
      );
    }
    const fileName = `${e2e.runId}-ui.png`;

    try {
      await uiLogin(page);

      // Open the catalog (Headphones = products) collection and a new record form,
      // which renders the RecordForm + ImageManager for the `imageIds` field.
      await page.getByRole('button', { name: 'Headphones' }).click();
      await page.getByRole('button', { name: /^New / }).click();

      // The ImageManager file input is hidden behind a styled label; set files on it
      // directly. This drives the real intent → COS multipart POST → completeUpload.
      const fileInput = page.locator('input[type="file"]');
      await fileInput.waitFor({ state: 'attached' });
      await fileInput.setInputFiles({ name: fileName, mimeType: 'image/png', buffer: onePixelPng });

      // The transient "Uploading…" tile clears and the uploaded image previews via an
      // object URL <img>. A generous timeout covers the live round-trip.
      await expect(page.getByText('Uploading…')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('img[alt=""]').first()).toBeVisible({ timeout: 30_000 });
      // No per-file "Failed — retry" tile should appear.
      await expect(page.getByText('Failed — retry')).toHaveCount(0);
    } finally {
      // The completeUpload step created an active image doc (publishedRefCount 0);
      // remove it by its file name. The underlying COS object is left for MIU-06
      // orphan cleanup (acceptable for the test env; `e2e-`/`ui` naming identifies it).
      try {
        const session = await loginAdmin(request);
        const matches = await adminAction<ListResult<CollectionDoc>>(
          request,
          'list',
          {
            collection: 'images',
            page: 1,
            pageSize: 10,
            filter: { combinator: 'and', clauses: [{ field: 'name', op: 'eq', value: fileName }] },
          },
          session.token,
        );
        for (const img of matches.items) {
          await adminAction<{ deleted: boolean }>(
            request,
            'remove',
            { collection: 'images', id: img._id },
            session.token,
          ).catch(() => {
            /* best-effort cleanup */
          });
        }
      } catch {
        /* best-effort cleanup; never fail the test on teardown */
      }
    }
  });
});

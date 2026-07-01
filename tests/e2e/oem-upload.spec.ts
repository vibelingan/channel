import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  type CollectionDoc,
  type ListResult,
  adminAction,
  loginAdmin,
  removeIfPresent,
} from './helpers/admin-api';
import { e2e, hasAdminCredentials } from './helpers/env';

test.describe.configure({ mode: 'serial' });

/**
 * MIU-08 Increment 6 — deployed OEM upload smoke (live-env evidence gate).
 *
 * Proves the whole private-attachment path against a REAL CloudBase deployment:
 * a public visitor uploads a multi-MiB ZIP through the OEM form, the browser sends
 * it via a DIRECT COS POST (never through the Event Function body — which caps at
 * ~100 KiB and would 413 `EXCEED_MAX_PAYLOAD_SIZE`), `submitProject` finalizes it
 * server-side (magic-byte sniff + size + checksum), and an admin can mint a
 * short-TTL private download. Public byte routes stay 404.
 *
 * Gated behind `E2E_OEM_UPLOAD_SMOKE=1` (+ admin creds + `E2E_SITE_URL`/
 * `E2E_API_URL` pointing at the deployed env). The browser upload also requires
 * the site origin in the env's CloudBase security domains / bucket CORS (skill
 * rule STORAGE001) — an ops prerequisite handled at deploy time.
 */

/**
 * Fixture size. Defaults to 2 MiB — 20x the ~100 KiB Event-Function body cap, so
 * it still proves bytes go DIRECT to COS (not through the function) while
 * uploading reliably from a cross-region CI runner. The near-cap 9-10 MiB case is
 * slow trans-pacific and is validated separately by a local probe; override with
 * `E2E_OEM_SMOKE_BYTES` (up to the 10 MiB `OEM_FILE_MAX_BYTES` cap).
 */
const OEM_ZIP_BYTES = (() => {
  const override = Number(process.env.E2E_OEM_SMOKE_BYTES);
  return Number.isFinite(override) && override > 0 ? override : 2 * 1024 * 1024;
})();

/**
 * A realistic "ZIP": a real ZIP local-file signature (`PK\x03\x04`) followed by
 * incompressible random padding. Finalization sniffs the leading magic bytes (not
 * full archive validity) and recomputes size/checksum, so this exercises the true
 * multi-MiB direct-upload path without needing a ZIP writer dependency. Random
 * padding keeps the object incompressible so its stored size stays put.
 */
function buildOemZip(): Buffer {
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const padding = randomBytes(OEM_ZIP_BYTES - signature.length);
  return Buffer.concat([signature, padding]);
}

interface OemFileDownload {
  fileId: string;
  url: string;
  fileName: string;
  mimeType: string;
  contentDisposition: string;
  expiresAt?: string;
}

test.describe('MIU-08 deployed OEM upload smoke', () => {
  test.skip(
    !e2e.oemUploadSmoke,
    'Set E2E_OEM_UPLOAD_SMOKE=1 (plus admin credentials + deployed env URLs) to run the OEM ZIP upload smoke.',
  );

  test('public OEM form uploads a multi-MiB ZIP via direct COS POST, finalizes, and admin can mint a private download', async ({
    page,
    request,
  }) => {
    if (!hasAdminCredentials()) {
      throw new Error(
        'E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required when E2E_OEM_UPLOAD_SMOKE=1.',
      );
    }

    // A ~9.5 MiB browser->COS upload plus the server-side finalization (which
    // re-downloads the object to re-hash it) can run well past the default
    // per-test timeout from a cross-region CI runner. Give it generous headroom.
    test.setTimeout(180_000);

    const session = await loginAdmin(request);
    const company = `${e2e.runId} OEM ZIP Smoke`;
    const zip = buildOemZip();
    let projectId = '';
    let fileId = '';

    try {
      await page.goto('/oem#submit', { waitUntil: 'domcontentloaded' });
      const form = page.locator('form[data-project-form]');
      await form.locator('[name="company"]').fill(company);
      await form.locator('[name="contact"]').fill('E2E Contact');
      await form.locator('[name="email"]').fill(`${e2e.runId}@example.test`);
      await form.locator('[name="whatsapp"]').fill('+1 555 0100');
      await form.locator('[name="category"]').selectOption('Headphones');
      await form.locator('[name="quantity"]').fill('5000');
      await form.locator('[name="drawing"]').setInputFiles({
        name: `${e2e.runId}-drawing.zip`,
        mimeType: 'application/zip',
        buffer: zip,
      });
      await page.getByRole('button', { name: /Submit project/i }).click();

      // Reaching the result page proves the 9-10 MiB ZIP went through the direct
      // COS POST: a base64-through-Event-Function path would have failed with
      // 413 EXCEED_MAX_PAYLOAD_SIZE well before this navigation. If the form
      // instead surfaces an inline error, fail FAST with that message rather than
      // waiting out the whole timeout on an opaque URL check.
      const formError = page.locator('form[data-project-form] [data-error]');
      await Promise.race([
        expect(page).toHaveURL(/\/oem_submit_result\?id=/, { timeout: 150_000 }),
        formError.waitFor({ state: 'visible', timeout: 150_000 }).then(async () => {
          throw new Error(`OEM form submission failed: ${(await formError.textContent())?.trim()}`);
        }),
      ]);
      const referenceId = new URL(page.url()).searchParams.get('id') ?? '';
      expect(referenceId).not.toBe('');

      async function findSubmittedProject(): Promise<CollectionDoc | null> {
        const result = await adminAction<ListResult<CollectionDoc>>(
          request,
          'list',
          { collection: 'oemProjects', page: 1, pageSize: 5, search: company },
          session.token,
        );
        return result.items.find((item) => item.company === company) ?? null;
      }

      await expect
        .poll(async () => (await findSubmittedProject())?._id ?? '', { timeout: 30_000 })
        .not.toBe('');

      const project = await findSubmittedProject();
      if (!project) throw new Error('OEM project was not readable after submit.');
      projectId = project._id;
      expect(project.company).toBe(company);
      fileId = typeof project.drawing === 'string' ? project.drawing : '';
      expect(fileId, 'finalized project must reference a storage-backed drawing').not.toBe('');

      // The finalized file must not be reachable through any public byte route.
      const asFile = await request.get(`${e2e.apiUrl}/api/files/${encodeURIComponent(fileId)}`);
      expect(asFile.status()).toBe(404);
      const asImage = await request.get(`${e2e.apiUrl}/api/images/${encodeURIComponent(fileId)}`, {
        headers: { Origin: e2e.siteUrl },
      });
      expect(asImage.status()).toBe(404);

      // Admin-only delivery (Increment 4 + the P2 download contract): the action
      // mints a short-TTL https temp URL and carries the display filename. We
      // assert the mint contract here; actually fetching the temp URL bytes is a
      // cross-origin GET that additionally requires bucket GET CORS / security
      // domains (STORAGE001), configured at deploy time.
      const download = await adminAction<OemFileDownload>(
        request,
        'getOemFileDownloadUrl',
        { fileId },
        session.token,
      );
      expect(download.fileId).toBe(fileId);
      expect(download.url).toMatch(/^https:\/\//);
      expect(download.fileName).toBeTruthy();
    } finally {
      if (projectId) await removeIfPresent(request, session, 'oemProjects', projectId);
      if (fileId) await removeIfPresent(request, session, 'files', fileId);
    }
  });
});

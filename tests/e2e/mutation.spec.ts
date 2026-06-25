import { Buffer } from 'node:buffer';
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

test.describe('mutation e2e flows', () => {
  test.skip(
    !e2e.allowMutation || !hasAdminCredentials(),
    'Set E2E_ALLOW_MUTATION=1 plus admin credentials to run DB-writing e2e.',
  );

  test('admin-created published product appears in the public catalog and is cleaned up', async ({
    page,
    request,
  }) => {
    const session = await loginAdmin(request);
    const productName = `${e2e.runId}-Headphones`;
    let productId = '';

    try {
      const product = await adminAction<CollectionDoc>(
        request,
        'create',
        {
          collection: 'products',
          values: {
            name: productName,
            category: 'wired',
            series: 'E2E',
            modName: 'E2E Model',
            modType: 'Browser Test',
            description: 'Created by Playwright e2e and removed in cleanup.',
            moq: 1,
            unitPrice: 12.34,
            wholesalePrice: 10.5,
            vipPrice: 9.5,
            imageIds: [],
            published: true,
          },
        },
        session.token,
      );
      productId = product._id;

      await expect
        .poll(async () => {
          const response = await request.get(
            `${e2e.apiUrl}/api/products?search=${encodeURIComponent(productName)}&pageSize=5`,
            { headers: { Origin: e2e.siteUrl } },
          );
          const body = (await response.json()) as { ok: boolean; data?: ListResult<CollectionDoc> };
          return body.ok === true && body.data?.items.some((item) => item._id === productId);
        })
        .toBe(true);

      await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder(/Search products/i).fill(productName);
      await expect(page.getByText(productName)).toBeVisible({ timeout: 15_000 });
    } finally {
      if (productId) await removeIfPresent(request, session, 'products', productId);
    }
  });

  test('OEM browser submission writes a project and keeps file downloads unexposed', async ({
    page,
    request,
  }) => {
    const session = await loginAdmin(request);
    const company = `${e2e.runId} OEM Company`;
    let projectId = '';
    let fileId = '';

    try {
      await page.goto('/oem#submit', { waitUntil: 'domcontentloaded' });
      await page.getByLabel(/Company Name/i).fill(company);
      await page.getByLabel(/Contact Person/i).fill('E2E Contact');
      await page.getByLabel(/^Email/i).fill(`${e2e.runId}@example.test`);
      await page.getByLabel(/WhatsApp/i).fill('+1 555 0100');
      await page.getByLabel(/Product Category/i).selectOption('Headphones');
      await page.getByLabel(/Estimated Quantity/i).fill('5000');
      await page.getByLabel(/Upload Drawing/i).setInputFiles({
        name: `${e2e.runId}-drawing.pdf`,
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n% e2e drawing placeholder\n'),
      });
      await page.getByRole('button', { name: /Submit project/i }).click();
      await expect(page).toHaveURL(/\/oem_submit_result\?id=/, { timeout: 20_000 });

      const url = new URL(page.url());
      projectId = url.searchParams.get('id') ?? '';
      expect(projectId).not.toBe('');

      const project = await adminAction<CollectionDoc>(
        request,
        'get',
        { collection: 'oemProjects', id: projectId },
        session.token,
      );
      expect(project.company).toBe(company);
      expect(project.status).toBe('new');
      fileId = typeof project.drawing === 'string' ? project.drawing : '';

      if (fileId) {
        const file = await request.get(`${e2e.apiUrl}/api/files/${encodeURIComponent(fileId)}`);
        expect(file.status()).toBe(404);
      }
    } finally {
      if (projectId) await removeIfPresent(request, session, 'oemProjects', projectId);
      if (fileId) await removeIfPresent(request, session, 'files', fileId);
    }
  });
});

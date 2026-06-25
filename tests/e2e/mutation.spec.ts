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
    let linkedImageId = '';
    let unlinkedImageId = '';

    try {
      const imageData = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#123456"/></svg>',
      ).toString('base64');
      const linkedImage = await adminAction<CollectionDoc>(
        request,
        'create',
        {
          collection: 'images',
          values: {
            name: `${e2e.runId}-linked.svg`,
            mimeType: 'image/svg+xml',
            data: imageData,
          },
        },
        session.token,
      );
      linkedImageId = linkedImage._id;

      const unlinkedImage = await adminAction<CollectionDoc>(
        request,
        'create',
        {
          collection: 'images',
          values: {
            name: `${e2e.runId}-unlinked.svg`,
            mimeType: 'image/svg+xml',
            data: imageData,
          },
        },
        session.token,
      );
      unlinkedImageId = unlinkedImage._id;

      const hiddenImage = await request.get(
        `${e2e.apiUrl}/api/images/${encodeURIComponent(unlinkedImageId)}`,
        { headers: { Origin: e2e.siteUrl } },
      );
      expect(hiddenImage.status()).toBe(404);

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
            imageIds: [linkedImageId],
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

      const linkedImageResponse = await request.get(
        `${e2e.apiUrl}/api/images/${encodeURIComponent(linkedImageId)}`,
        { headers: { Origin: e2e.siteUrl } },
      );
      expect(linkedImageResponse.status()).toBe(200);
      expect(linkedImageResponse.headers()['content-type']).toContain('image/svg+xml');
    } finally {
      if (productId) await removeIfPresent(request, session, 'products', productId);
      if (linkedImageId) await removeIfPresent(request, session, 'images', linkedImageId);
      if (unlinkedImageId) await removeIfPresent(request, session, 'images', unlinkedImageId);
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
      const form = page.locator('form[data-project-form]');
      await form.locator('[name="company"]').fill(company);
      await form.locator('[name="contact"]').fill('E2E Contact');
      await form.locator('[name="email"]').fill(`${e2e.runId}@example.test`);
      await form.locator('[name="whatsapp"]').fill('+1 555 0100');
      await form.locator('[name="category"]').selectOption('Headphones');
      await form.locator('[name="quantity"]').fill('5000');
      await form.locator('[name="drawing"]').setInputFiles({
        name: `${e2e.runId}-drawing.pdf`,
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n% e2e drawing placeholder\n'),
      });
      await page.getByRole('button', { name: /Submit project/i }).click();
      await expect(page).toHaveURL(/\/oem_submit_result\?id=/, { timeout: 20_000 });

      const url = new URL(page.url());
      const referenceId = url.searchParams.get('id') ?? '';
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
        .poll(async () => {
          return (await findSubmittedProject())?._id ?? '';
        })
        .not.toBe('');

      const project = await findSubmittedProject();
      if (!project) throw new Error('OEM project was not readable after submit.');
      projectId = project._id;
      expect(project.company).toBe(company);
      expect(project.status).toBe('new');
      fileId = typeof project.drawing === 'string' ? project.drawing : '';
      expect(fileId).not.toBe('');

      const file = await request.get(`${e2e.apiUrl}/api/files/${encodeURIComponent(fileId)}`);
      expect(file.status()).toBe(404);

      const fileAsImage = await request.get(
        `${e2e.apiUrl}/api/images/${encodeURIComponent(fileId)}`,
        { headers: { Origin: e2e.siteUrl } },
      );
      expect(fileAsImage.status()).toBe(404);
    } finally {
      if (projectId) await removeIfPresent(request, session, 'oemProjects', projectId);
      if (fileId) await removeIfPresent(request, session, 'files', fileId);
    }
  });
});

import { Buffer } from 'node:buffer';
import { type Page, expect, test } from '@playwright/test';

const adminUser = {
  id: 'user-1',
  email: 'admin@example.test',
  username: 'Admin',
  role: 'admin',
} as const;

const product = {
  _id: 'product-1',
  name: 'Office Headset',
  productFamily: 'headphones',
  category: 'office',
  skuCode: 'HP-100',
  slug: 'office-headset',
  description: 'Office headset for OEM programs.',
  imageIds: Array.from({ length: 9 }, (_, index) => `image-${index + 1}`),
  published: false,
  archived: false,
  alibabaSourceStatus: 'available',
  alibabaSourceLastSyncedAt: '2026-08-20T00:00:00.000Z',
};

async function seedAdminSession(page: Page) {
  await page.addInitScript((user) => {
    if (!window.location.pathname.startsWith('/admin')) return;
    localStorage.setItem('channel.token', 'valid-token');
    localStorage.setItem('channel.user', JSON.stringify(user));
  }, adminUser);
}

test('product edit form groups fields, clears incompatible category, and enforces nine images', async ({
  page,
}) => {
  await seedAdminSession(page);
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: Record<string, unknown>;
    };
    const response =
      body.action === 'me'
        ? { ok: true, data: { user: adminUser } }
        : body.action === 'list'
          ? { ok: true, data: { items: [product], total: 1, page: 1, pageSize: 20 } }
          : body.action === 'getImagePreview'
            ? { ok: true, data: { id: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' } }
            : { ok: false, error: { code: 'BAD_REQUEST', message: 'Unexpected action' } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Product' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Identity' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Media' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Pricing & Order' })).toBeVisible();
  await expect(page.getByLabel('VIP Price')).toHaveCount(0);
  await expect(page.getByLabel('Alibaba Source Status')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Alibaba Source' })).toBeVisible();
  await expect(page.getByText('Primary', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Add product images')).toBeDisabled();
  await expect(page.locator('#imageIds-capacity')).toContainText(
    '9 of 9 images. Remove an image to add another.',
  );

  await page.getByLabel('Product Family', { exact: true }).selectOption('toys');
  await expect(page.getByLabel('Subcategory')).toHaveValue('');
  await expect(page.locator('[data-product-form-announcement]')).toContainText(
    'Subcategory cleared because it applies only to Headphones.',
  );
});

test('product server errors attach to slug and publication fields', async ({ page }) => {
  await seedAdminSession(page);
  let updateAttempt = 0;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: Record<string, unknown>;
    };
    let response: unknown;
    if (body.action === 'me') response = { ok: true, data: { user: adminUser } };
    else if (body.action === 'list') {
      response = {
        ok: true,
        data: { items: [{ ...product, imageIds: [] }], total: 1, page: 1, pageSize: 20 },
      };
    } else if (body.action === 'update') {
      updateAttempt += 1;
      response =
        updateAttempt === 1
          ? {
              ok: false,
              error: {
                code: 'CONFLICT',
                message: 'Product slug is already in use: office-headset',
              },
            }
          : {
              ok: false,
              error: {
                code: 'VALIDATION_ERROR',
                message:
                  'SKU code is required to publish; At least one product image is required to publish',
              },
            };
    } else response = { ok: false, error: { code: 'BAD_REQUEST', message: 'Unexpected action' } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('URL Slug')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#slug-error')).toContainText('already in use');

  await page.getByLabel('Published').check();
  await page.getByLabel('SKU Code').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('SKU Code')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#skuCode-error')).toContainText('required to publish');
  await expect(page.locator('#imageIds-error')).toContainText('At least one product image');
  await expect(page.getByLabel('Add product images')).toHaveAttribute(
    'aria-describedby',
    /imageIds-capacity imageIds-error/,
  );
});

test('Save waits for an in-flight image upload and re-enables after completion', async ({
  page,
}) => {
  await seedAdminSession(page);
  let releaseIntent: (() => void) | undefined;
  const intentReleased = new Promise<void>((resolve) => {
    releaseIntent = resolve;
  });
  await page.route('**/fake-image-upload', (route) => route.fulfill({ status: 200 }));
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: Record<string, unknown>;
    };
    let response: unknown;
    if (body.action === 'me') response = { ok: true, data: { user: adminUser } };
    else if (body.action === 'list') {
      response = {
        ok: true,
        data: {
          items: [{ ...product, imageIds: product.imageIds.slice(0, 8) }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      };
    } else if (body.action === 'createUploadIntent') {
      await intentReleased;
      response = {
        ok: true,
        data: {
          imageId: 'image-9',
          uploadIntentId: 'intent-9',
          storageFileId: 'storage-9',
          upload: { method: 'PUT', url: 'http://127.0.0.1:4332/fake-image-upload', headers: {} },
        },
      };
    } else if (body.action === 'completeUpload') response = { ok: true, data: { completed: true } };
    else response = { ok: false, error: { code: 'BAD_REQUEST', message: 'Unexpected action' } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Add product images').setInputFiles({
    name: 'ninth.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image'),
  });
  await expect(page.getByRole('button', { name: 'Waiting for uploads…' })).toBeDisabled();
  releaseIntent?.();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  await expect(page.locator('#imageIds-capacity')).toContainText('9 of 9 images');
});

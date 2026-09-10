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

test('list and editor retain a known source MOQ without a usable source price', async ({
  page,
}) => {
  await seedAdminSession(page);
  // Shape observed in the repaired live paper-basket draft: unavailable price
  // is legitimate, but it must not suppress the independently supplied MOQ.
  const draft = {
    ...product,
    imageIds: [],
    alibabaPrimarySourceKey: 'source-moq-only',
    alibabaSourceReview: {
      schemaVersion: 'alibaba-source-review-v1',
      provider: 'alibaba',
      externalProductId: 'source-moq-only',
      sourceListingStatus: 'published',
      variantCount: 2,
      offerCount: 3,
      modelNumbers: [],
      optionNames: ['capacity', 'color'],
      minimumOrderQuantity: 1,
      primaryPricing: { mode: 'unavailable', minimumOrderQuantity: 1 },
    },
  };
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON();
    const data =
      body.action === 'me'
        ? { user: adminUser }
        : body.action === 'list'
          ? { items: [draft], total: 1, page: 1, pageSize: 20 }
          : {};
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: draft.name });
  await expect(row).toContainText('1 (source)');
  await expect(row).toContainText('Pricing unavailable');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
  const effective = editor.getByRole('region', { name: 'Effective website pricing' });
  await expect(effective).toContainText('Minimum order quantity: 1');
  await expect(effective).toContainText('Pricing unavailable');
  await expect(effective).not.toContainText('0.00');
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(editor).toHaveCount(0);
});

test('editor uses desktop space, contains scrolling, previews images and protects unsaved work', async ({
  page,
}) => {
  await seedAdminSession(page);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=';
  const sourceUrls = [
    'https://sc04.alicdn.com/editor-first.png',
    'https://sc04.alicdn.com/editor-broken.png',
  ] as const;
  const draft = {
    ...product,
    description: 'Supplier description. '.repeat(100),
    imageIds: ['one', 'two'],
    alibabaSourceImageUrls: [...sourceUrls, sourceUrls[0], 'javascript:alert(1)', null],
    alibabaPrimarySourceKey: 'private-integration-key',
    alibabaSourceCategoryId: '1234567890',
  };
  let writes = 0;
  await page.route('https://sc04.alicdn.com/editor-*', (route) =>
    route.fulfill({
      status: route.request().url().includes('broken') ? 404 : 200,
      contentType: 'image/png',
      body: route.request().url().includes('broken') ? 'not an image' : Buffer.from(png, 'base64'),
    }),
  );
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'update') writes++;
    const data =
      body.action === 'me'
        ? { user: adminUser }
        : body.action === 'getImagePreview'
          ? { id: body.data.id, mimeType: 'image/png', dataBase64: png }
          : body.action === 'list'
            ? { items: [draft], total: 1, page: 1, pageSize: 20 }
            : {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data }),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Product', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('private-integration-key');
  await expect(dialog).not.toContainText('Alibaba Source Images');
  await expect(dialog.getByRole('button', { name: /Preview source image/ })).toHaveCount(2);
  const close = dialog.getByRole('button', { name: 'Close editor' });
  await expect(close).toBeFocused();
  // Browser-native modality: Shift-Tab must stay in the editor, never the table.
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await dialog.evaluate((el) => {
      const box = (selector: string, section = false) => {
        const node = section
          ? Array.from(el.querySelectorAll('fieldset')).find(
              (field) => field.querySelector('legend')?.textContent === selector,
            )
          : el.querySelector(selector);
        if (!node) throw new Error(`Missing editor section ${selector}`);
        const b = node.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, bottom: b.bottom };
      };
      return {
        width: el.getBoundingClientRect().width,
        overflow: el.scrollWidth > el.clientWidth,
        identity: box('Identity', true),
        identityLastField: box('#slug'),
        content: box('Content', true),
        media: box('Media', true),
        pricing: box('Pricing & Order', true),
        actions: box('[data-record-form-actions]'),
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.width).toBeLessThanOrEqual(width);
    if (width >= 1024) {
      expect(geometry.width).toBeGreaterThan(width * 0.7);
      expect(geometry.media.x).toBeGreaterThan(geometry.identity.x + geometry.identity.width);
      expect(Math.abs(geometry.media.y - geometry.identity.y)).toBeLessThan(3);
      // Width alone missed a stretched, mostly empty Identity card. Each
      // column must stack compactly, independently of its taller neighbour.
      expect(geometry.identity.bottom - geometry.identityLastField.bottom).toBeLessThanOrEqual(32);
      expect(geometry.content.y - geometry.identity.bottom).toBeGreaterThanOrEqual(12);
      expect(geometry.content.y - geometry.identity.bottom).toBeLessThanOrEqual(32);
      expect(geometry.pricing.y - geometry.media.bottom).toBeGreaterThanOrEqual(12);
      expect(geometry.pricing.y - geometry.media.bottom).toBeLessThanOrEqual(32);
    } else expect(Math.abs(geometry.media.x - geometry.identity.x)).toBeLessThan(3);
    expect(geometry.actions.bottom).toBeLessThanOrEqual(900);
    await expect(close).toBeInViewport();
    await dialog.locator('[data-record-form-body]').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(close).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
    await expect(dialog.getByLabel('Archived', { exact: true })).toBeInViewport();
    await dialog.locator('[data-record-form-body]').evaluate((el) => {
      el.scrollTop = 0;
    });
    if (width === 1440 || width === 390)
      await dialog.screenshot({ path: `output/playwright/editor-${width}.png` });
  }
  await dialog.getByRole('button', { name: 'Preview source image 1', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Image preview', exact: true });
  await expect(viewer.getByRole('img')).toHaveAttribute('src', sourceUrls[0]);
  await expect(viewer.getByRole('img')).toHaveJSProperty('naturalWidth', 1);
  await expect(viewer.getByRole('button', { name: 'Previous image' })).toBeDisabled();
  await viewer.getByRole('button', { name: 'Next image' }).click();
  await expect(viewer).toContainText('Image unavailable');
  await expect(viewer.getByRole('button', { name: 'Next image' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Preview source image 1', exact: true }),
  ).toBeFocused();
  await dialog.getByRole('button', { name: 'Preview product image 1', exact: true }).click();
  await expect(viewer.getByRole('img')).toHaveAttribute('src', /^blob:/);
  await expect(viewer.getByRole('img')).toHaveJSProperty('naturalWidth', 1);
  const ownedPreviewUrl = await viewer.getByRole('img').getAttribute('src');
  await viewer.getByRole('button', { name: 'Next image' }).click();
  await expect(viewer.getByRole('status')).toHaveText('2 / 2');
  await viewer.getByRole('button', { name: 'Close image preview' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Preview product image 1', exact: true }),
  ).toBeFocused();
  await dialog.getByRole('textbox', { name: /^Name\b/ }).fill('Unsaved edit');
  await close.click();
  await expect(dialog).toContainText('Discard your unsaved changes?');
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByRole('textbox', { name: /^Name\b/ })).toHaveValue('Unsaved edit');
  // Escape in an open select closes only its options, not the editor.
  await dialog.locator('#productFamily-trigger').click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toContainText('Discard your unsaved changes?');
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(
    await page.evaluate(async (url) => {
      if (!url) throw new Error('Owned preview URL was not created');
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, ownedPreviewUrl),
  ).toBe(true);
  expect(writes).toBe(0);
  await edit.click();
  await expect(dialog.getByRole('textbox', { name: /^Name\b/ })).toHaveValue(product.name);
  await close.click();
  await expect(dialog).toHaveCount(0);
});

test('source gallery imports every distinct image, retains partial success, and survives save/reopen', async ({
  page,
}) => {
  await seedAdminSession(page);
  const sourceUrls = [
    'https://sc04.alicdn.com/first.jpg',
    'https://sc04.alicdn.com/second.jpg',
    'https://sc04.alicdn.com/first.jpg',
    'https://sc04.alicdn.com/third.jpg',
  ];
  let saved = { ...product, imageIds: ['existing-image'], alibabaSourceImageUrls: sourceUrls };
  const calls: string[] = [];
  let failSecond = true;
  await page.route('**/api/alibaba-catalog-sync', async (route) => {
    const body = route.request().postDataJSON() as { action: string; data: { url: string } };
    expect(body.action).toBe('importSourceImage');
    calls.push(body.data.url);
    const position = sourceUrls.indexOf(body.data.url);
    const failed = position === 1 && failSecond;
    await route.fulfill({
      status: failed ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        failed
          ? {
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'Source image is temporarily invalid.' },
            }
          : {
              ok: true,
              data: {
                imageId: `source-${position}`,
                deduplicated: calls.filter((url) => url === body.data.url).length > 1,
              },
            },
      ),
    });
  });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      data: { values?: Partial<typeof saved> };
    };
    let response: unknown;
    if (body.action === 'me') response = { ok: true, data: { user: adminUser } };
    else if (body.action === 'list')
      response = { ok: true, data: { items: [saved], total: 1, page: 1, pageSize: 20 } };
    else if (body.action === 'getImagePreview')
      response = {
        ok: true,
        data: { id: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      };
    else if (body.action === 'update') {
      saved = { ...saved, ...body.data.values };
      response = { ok: true, data: saved };
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
  await page.getByRole('button', { name: 'Import source gallery' }).click();
  await expect(page.getByText(/Source image 2: Source image is temporarily invalid/)).toBeVisible();
  await expect(page.locator('#imageIds-capacity')).toContainText('3 of 9 images');
  expect(calls).toEqual([sourceUrls[0], sourceUrls[1], sourceUrls[3]]);
  failSecond = false;
  await page.getByRole('button', { name: 'Import source gallery' }).click();
  await expect(page.locator('#imageIds-capacity')).toContainText('4 of 9 images');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Product' })).toHaveCount(0);
  expect(saved.imageIds).toEqual(['existing-image', 'source-0', 'source-3', 'source-1']);
  expect(saved.published).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#imageIds-capacity')).toContainText('4 of 9 images');
  await expect(page.getByText('Primary', { exact: true })).toBeVisible();
});

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
  await expect(page.getByRole('heading', { name: 'Alibaba Source', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close editor' })).toBeVisible();
  await expect(page.getByText('Primary', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Add product images')).toBeDisabled();
  await expect(page.getByLabel('Add description images')).toBeEnabled();
  await expect(page.locator('#descriptionImageIds-capacity')).not.toContainText('primary');
  await expect(page.locator('#imageIds-capacity')).toContainText(
    '9 of 9 images. Remove an image to add another.',
  );

  const productFamily = page.locator('button#productFamily-trigger[role="combobox"]');
  await productFamily.click();
  await page
    .getByRole('listbox', { name: 'Website main category', exact: true })
    .getByRole('option', { name: 'Toys', exact: true })
    .click();
  await expect(page.locator('select#productFamily')).toHaveValue('toys');
  await expect(page.getByLabel('Headphone type (optional)')).toHaveCount(0);
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
    else if (body.action === 'catalogDetailCapabilities')
      response = { ok: true, data: { enabled: false } };
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
                message: 'At least one product image is required to publish',
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
  await expect(page.getByLabel('SKU Code')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#imageIds-error')).toContainText('At least one product image');
  await expect(page.getByLabel('Add product images')).toHaveAttribute(
    'aria-describedby',
    /imageIds-capacity imageIds-error/,
  );
});

test('manual tier pricing is keyboard-editable, blocks invalid drafts, and submits exact payload', async ({
  page,
}) => {
  await seedAdminSession(page);
  let updateValues: Record<string, unknown> | undefined;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: { values?: Record<string, unknown> };
    };
    let response: unknown;
    if (body.action === 'me') response = { ok: true, data: { user: adminUser } };
    else if (body.action === 'list') {
      response = {
        ok: true,
        data: {
          items: [
            {
              ...product,
              productFamily: 'toys',
              category: undefined,
              skuCode: '',
              slug: '',
              imageIds: [],
              moq: 1,
              unitPrice: 134.18,
              wholesalePrice: 118.31,
              manualCatalogPricing: '',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      };
    } else if (body.action === 'update') {
      updateValues = body.data?.values;
      response = { ok: true, data: { ...product, ...updateValues } };
    } else response = { ok: false, error: { code: 'BAD_REQUEST', message: 'Unexpected action' } };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Product' });
  await expect(dialog.getByLabel('Headphone type (optional)')).toHaveCount(0);
  await expect(dialog.getByLabel('SKU Code')).toHaveValue('');
  await expect(dialog.getByLabel('URL Slug')).toHaveValue('');
  await expect(dialog.getByLabel('Minimum order quantity', { exact: true })).toHaveValue('1');
  await expect(dialog.getByLabel('Website unit price (USD)', { exact: true })).toHaveValue(
    '118.31',
  );
  await expect(dialog.getByLabel('Wholesale Price', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Unit Price', { exact: true })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Add price tier' }).click();
  await dialog.getByLabel('Minimum quantity').fill('');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(dialog.getByRole('alert').filter({ hasText: 'minimum quantity' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add price tier' })).toBeDisabled();

  await dialog.getByLabel('Minimum quantity').fill('1');
  await dialog.getByLabel('Maximum quantity').fill('12');
  await dialog.getByLabel('Unit price (USD)').fill('134.18');
  await dialog.getByRole('button', { name: 'Add price tier' }).click();
  const minimums = dialog.getByLabel('Minimum quantity');
  await expect(minimums).toHaveCount(2);
  await expect(minimums.nth(1)).toHaveValue('13');
  await dialog.getByLabel('Unit price (USD)').nth(1).fill('118.31');

  const removeSecond = dialog.getByRole('button', { name: 'Remove tier 2' });
  await removeSecond.focus();
  await removeSecond.press('Enter');
  await expect(dialog.getByLabel('Minimum quantity')).toBeFocused();

  await dialog.getByRole('button', { name: 'Add price tier' }).click();
  await dialog.getByLabel('Unit price (USD)').nth(1).fill('118.31');
  expect(
    await dialog.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.getBoundingClientRect().right <= window.innerWidth,
    ),
  ).toBe(true);
  if (process.env.E2E_RECORD_ARTIFACTS) {
    await dialog.locator('button#manualCatalogPricing-currency-trigger[role="combobox"]').click();
    await page.screenshot({
      path: 'output/playwright/shared-select-admin-mobile.png',
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.locator('button#productFamily-trigger[role="combobox"]').click();
    await page.screenshot({
      path: 'output/playwright/shared-select-admin-desktop.png',
      fullPage: true,
    });
    await page.keyboard.press('Escape');
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => updateValues).toBeTruthy();
  expect(updateValues).toMatchObject({
    productFamily: 'toys',
    moq: 1,
    unitPrice: 134.18,
    wholesalePrice: 118.31,
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [
        { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
        { minQuantity: 13, unitAmountMinor: 11_831 },
      ],
    },
  });
  expect(updateValues).not.toHaveProperty('category');
});

for (const purpose of ['gallery', 'description'] as const) {
  test(`Save waits for an in-flight ${purpose} image upload and re-enables after completion`, async ({
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
      } else if (body.action === 'completeUpload')
        response = { ok: true, data: { completed: true } };
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
    await page
      .getByLabel(purpose === 'gallery' ? 'Add product images' : 'Add description images')
      .setInputFiles({
        name: 'ninth.png',
        mimeType: 'image/png',
        buffer: Buffer.from('image'),
      });
    await expect(page.getByRole('button', { name: 'Waiting for uploads…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close editor' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Edit Product' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    releaseIntent?.();
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
    await expect(
      page.locator(purpose === 'gallery' ? '#imageIds-capacity' : '#descriptionImageIds-capacity'),
    ).toContainText(purpose === 'gallery' ? '9 of 9 images' : '1 of 18 images');
    await expect(page.getByRole('button', { name: 'Close editor' })).toBeEnabled();
  });
}

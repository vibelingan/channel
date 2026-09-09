import { expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireCatalogLocalSeedWhenEnabled } from './helpers/env';

const enabled = process.env.E2E_CATALOG_FORMAL === '1';
// @skip-when this explicitly owned, disposable formal-journey lane is not requested.
test.skip(!enabled, 'Run with E2E_CATALOG_FORMAL=1 through the disposable catalog runner.');
requireCatalogLocalSeedWhenEnabled(enabled);

test('ordinary routes: approved multi-image SKU detail → real RFQ → persistent Admin follow-up', async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const session = await loginAdmin(request);
  const list = await adminAction<ListResult<CollectionDoc>>(
    request,
    'list',
    { collection: 'products', search: 'SonicAir Move', pageSize: 20 },
    session.token,
  );
  const id = list.items[0]?._id;
  if (!id) throw new Error('Formal product fixture missing');
  const forbidden = await request.post(`${e2e.apiUrl}/api/admin`, {
    data: {
      action: 'update',
      token: session.token,
      data: { collection: 'products', id, values: { published: true } },
    },
  });
  expect((await forbidden.json()).ok).toBe(false);
  await page.goto('/login?returnTo=%2Fadmin');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill('SonicAir Move');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'SonicAir Move' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  const product = await adminAction<CollectionDoc>(
    request,
    'get',
    { collection: 'products', id },
    session.token,
  );
  expect(product.catalogDetailPublication).toMatchObject({
    state: 'approved',
    variantCount: 21,
    variantStorage: 'immutable-v1',
  });
  expect(product.imageIds).toEqual(['formal-image-0', 'formal-image-1']);
  await page.goto(`/headphones/?id=${id}`);
  await expect(page.locator('[data-catalog-variant-selector]')).toBeVisible();
  expect(page.url()).not.toContain('preview=');
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: `View image ${index + 1}`, exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('[data-gallery-frame] img')
          .evaluate((img) =>
            img instanceof HTMLImageElement ? img.complete && img.naturalWidth > 0 : false,
          ),
      )
      .toBe(true);
  }
  await page.locator('[data-catalog-variant-selector] select').selectOption({ index: 2 });
  await expect(page.locator('[data-quote-open]')).toBeEnabled();
  await page.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('500');
  await expect(page.locator('main')).toContainText('3.80');
  await page.screenshot({ path: info.outputPath('normal-product-detail.png'), fullPage: true });
  await page.locator('[data-quote-open]').click();
  const dialog = page.locator('[data-catalog-quote-sheet]');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Requested quantity', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Continue to contact', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Requested quantity', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Continue to contact', exact: true }).click();
  await dialog.getByLabel('Contact name', { exact: true }).fill('Acceptance Buyer');
  await dialog.getByLabel('Email', { exact: true }).fill('acceptance@example.invalid');
  await dialog.getByLabel('Company', { exact: true }).fill('Local acceptance only');
  await dialog.getByRole('combobox').scrollIntoViewIfNeeded();
  await dialog.getByRole('combobox').click();
  await dialog.getByRole('combobox').pressSequentially('Brazil', { delay: 40 });
  await page.screenshot({ path: info.outputPath('country-popup.png') });
  await page.getByRole('option', { name: /Brazil/ }).click();
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  const receipt = page.waitForResponse(
    (r) => r.url().includes('/api/catalog-quote-requests') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Send inquiry', exact: true }).click();
  const response = await receipt;
  const saved = await response.json();
  expect(saved.ok).toBe(true);
  const replay = await request.post(`${e2e.apiUrl}/api/catalog-quote-requests`, {
    headers: { Origin: e2e.siteUrl },
    data: response.request().postDataJSON(),
  });
  expect(await replay.json()).toEqual(saved);
  await expect(dialog).toContainText(saved.requestId);
  await page.goto('/admin');
  await page.getByRole('button', { name: /Product Inquiries/ }).click();
  await expect(page.getByRole('main')).toContainText('1 unprocessed');
  await page.locator(`#inquiry-${saved.requestId}`).click();
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('Unprocessed');
  await page
    .getByLabel('Internal note', { exact: true })
    .fill('Read only; buyer not yet contacted.');
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.locator('[data-inquiry-version]')).toHaveAttribute('data-inquiry-version', '1');
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('Unprocessed');
  const stale = await request.post(`${e2e.apiUrl}/api/admin`, {
    data: {
      action: 'inquiry',
      token: session.token,
      data: {
        action: 'update',
        id: saved.requestId,
        version: 0,
        operationId: 'a42a8b21-0ebc-48a5-8a8e-bde4fabd2e80',
        status: 'completed',
        note: 'Stale browser must not overwrite a newer follow-up.',
      },
    },
  });
  expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  await page
    .getByLabel('Internal note', { exact: true })
    .fill('Buyer contacted during local acceptance.');
  await page.getByRole('combobox', { name: 'Next status', exact: true }).click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('In progress');
  await page
    .getByLabel('Internal note', { exact: true })
    .fill('Inquiry follow-up finished; this is not an order.');
  await page.getByRole('combobox', { name: 'Next status', exact: true }).click();
  await page.getByRole('option', { name: 'Completed', exact: true }).click();
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('Completed');
  await page.reload();
  await page.getByRole('button', { name: /Product Inquiries/ }).click();
  await expect(page.getByRole('main')).toContainText('0 unprocessed');
  await page.locator(`#inquiry-${saved.requestId}`).click();
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('Completed');
  await expect(
    page.getByText('Buyer contacted during local acceptance.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('admin-inquiry-followup.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/products/item/?slug=${product.slug}`);
  await expect(page.locator('[data-shared-catalog-detail]')).toBeVisible();
  expect(page.url()).not.toContain('preview=');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath('normal-product-detail-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

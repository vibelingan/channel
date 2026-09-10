import { expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireCatalogLocalSeedWhenEnabled } from './helpers/env';

const enabled = process.env.E2E_CATALOG_FORMAL === '1';
// @skip-when this explicitly owned, disposable formal-journey lane is not requested.
test.skip(!enabled, 'Run with E2E_CATALOG_FORMAL=1 through the disposable catalog runner.');
requireCatalogLocalSeedWhenEnabled(enabled);
// This journey intentionally changes one disposable database across its steps.
// A retry would start against the already-approved product, hiding the first failure.
test.describe.configure({ retries: 0 });

test('raw Alibaba response → draft/edit/preview → approved detail preserves facts, MOQ, quote scope and description media', async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const session = await loginAdmin(request);
  const list = await adminAction<ListResult<CollectionDoc>>(
    request,
    'list',
    { collection: 'products', search: 'Raw Wire Camping Light', pageSize: 20 },
    session.token,
  );
  const draft = list.items[0];
  if (!draft) throw new Error('Raw-derived materialized fixture missing');
  expect(draft.published).toBe(false);
  expect(draft.unitPrice).toBeUndefined();
  expect(draft.wholesalePrice).toBeUndefined();
  expect(draft.alibabaSourceReview).toMatchObject({
    minimumOrderQuantity: 1,
    primaryPricing: { mode: 'fixed', amountMinor: 767 },
  });
  const publicBefore = await request.get(`${e2e.apiUrl}/api/images/raw-wire-image-6`);
  expect(publicBefore.status()).toBe(404);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/login?returnTo=%2Fadmin');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill('Raw Wire Camping Light');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Raw Wire Camping Light' });
  await expect(row).toContainText('7.67');
  let mediaFailureInjected = false;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON();
    if (
      !mediaFailureInjected &&
      body.action === 'getImagePreview' &&
      body.data?.id === 'raw-wire-image-6'
    ) {
      mediaFailureInjected = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'UNAVAILABLE', message: 'Transient image failure' },
        }),
      });
    } else await route.continue();
  });
  await row.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Product preview', exact: true });
  await expect(preview.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 30000 });
  await expect(preview.getByRole('alert')).toContainText('Saved images have not been removed');
  expect(mediaFailureInjected).toBe(true);
  await preview.getByRole('button', { name: 'Retry images' }).click();
  await expect(preview).toContainText('USD 7.67');
  await expect(preview).toContainText('Minimum order quantity: 1');
  // 30 unambiguous facts + 17 values under repeated labels. The latter stay
  // in notes, not misleading single-valued headline specs.
  await expect(preview.locator('[data-catalog-specifications] dd')).toHaveCount(30);
  await expect(preview.locator('[data-catalog-notes] p')).toHaveCount(17);
  await expect(preview.locator('[data-catalog-notes]')).toContainText('Application — Hiking');
  await expect(preview.locator('[data-catalog-notes]')).toContainText('Application — Camping');
  await expect(preview.locator('[data-gallery-thumbnail]')).toHaveCount(6);
  await expect(preview.locator('[data-description-images] img')).toHaveCount(17);
  await expect(preview.getByRole('alert')).toHaveCount(0);
  await expect(preview).not.toContainText('No product description has been supplied');
  await expect(preview.locator('[data-quote-open]')).toBeDisabled();
  await preview.locator('[data-description-images] summary').click();
  const last = preview.locator('[data-description-images] img').last();
  await last.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      last.evaluate(
        (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  expect(await last.getAttribute('src')).toMatch(/^blob:/);
  await preview.screenshot({ path: info.outputPath('raw-description-private-preview.png') });
  await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
  await expect(editor.getByRole('region', { name: 'Effective website pricing' })).toContainText(
    '7.67',
  );
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select all rows' }).check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect
    .poll(
      async () => {
        const product = await adminAction<CollectionDoc>(
          request,
          'get',
          { collection: 'products', id: draft._id },
          session.token,
        );
        return product.published;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const saved = await adminAction<CollectionDoc>(
    request,
    'get',
    { collection: 'products', id: draft._id },
    session.token,
  );
  expect(saved.catalogDetailPublication).toMatchObject({
    state: 'approved',
    header: {
      facts: expect.arrayContaining([
        { name: 'Application', value: 'Hiking' },
        { name: 'Application', value: 'Camping' },
      ]),
      descriptionImages: expect.arrayContaining([
        '/api/images/raw-wire-image-6',
        '/api/images/raw-wire-image-22',
      ]),
    },
  });
  await page.goto(`/products/item/?id=${draft._id}`);
  await expect(page.locator('[data-shared-catalog-detail]')).toBeVisible();
  await expect(page.locator('[data-catalog-specifications] dd')).toHaveCount(30);
  await expect(page.locator('[data-catalog-notes] p')).toHaveCount(17);
  await expect(page.locator('main')).toContainText('USD 7.67');
  await expect(page.locator('main')).toContainText('Minimum order quantity: 1');
  await expect(page.locator('[data-description-images] img')).toHaveCount(17);
  expect((await request.get(`${e2e.apiUrl}/api/images/raw-wire-image-6`)).status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('raw-product-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('missing preview script keeps Admin usable and recovers after an explicit reload', async ({
  page,
  request,
}) => {
  const session = await loginAdmin(request);
  const getDraft = () =>
    adminAction<CollectionDoc>(
      request,
      'get',
      {
        collection: 'products',
        id: 'local-untouched-draft',
      },
      session.token,
    );
  const before = await getDraft();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let blocked = 0;
  const chunk = /\/_astro\/AdminDetailPreview\.[^/]+\.js$/;
  await page.route(chunk, (route) => {
    blocked++;
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });
  await page.route('https://s.alicdn.com/formal-*.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.goto('/login?returnTo=%2Fadmin');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  const openPreview = async () => {
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder(/^Search name/).fill('Untouched Sync Headset');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: 'Untouched Sync Headset' })
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
  };
  await openPreview();
  const dialog = page.getByRole('dialog', { name: 'Product preview', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Preview could not be loaded');
  expect(blocked).toBeGreaterThan(0);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true }).first()).toBeInViewport();
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await openPreview();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.unroute(chunk);
  await dialog.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await openPreview();
  await expect(dialog.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 30000 });
  await expect(dialog.locator('[data-gallery-thumbnail]')).toHaveCount(9);
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const after = await getDraft();
  expect(after.published).toBe(before.published);
  expect(after.catalogDetailPublication).toEqual(before.catalogDetailPublication);
  expect(after.imageIds).toEqual(before.imageIds);
  expect(after.alibabaReviewPending).toBe(before.alibabaReviewPending);
  expect(pageErrors).toEqual([]);
});

test('untouched sync draft: source prices, shared preview, pagination and accessible modal without publication', async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const session = await loginAdmin(request);
  const getDraft = () =>
    adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id: 'local-untouched-draft' },
      session.token,
    );
  const before = await getDraft();
  expect(before.imageIds).toBeUndefined();
  expect(before.catalogDetailPublication).toBeUndefined();
  const commands: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => {
    if (req.url().endsWith('/api/admin') && req.method() === 'POST') {
      const body = req.postDataJSON();
      if (body.action === 'catalogDetailApproval') commands.push(body.data.action);
    }
  });
  // Only image bytes are synthetic. All catalog/auth/approval requests use the
  // production handlers against this runner's disposable local database.
  await page.route('https://s.alicdn.com/formal-*.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.goto('/login?returnTo=%2Fadmin');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill('Untouched Sync Headset');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Untouched Sync Headset' });
  await expect(row).toContainText('Source: USD 6.00–7.89');
  await expect(row).toContainText('10 (source)');
  const preview = row.getByRole('button', { name: 'Preview', exact: true });
  await preview.click();
  const dialog = page.getByRole('dialog', { name: 'Product preview', exact: true });
  await expect(dialog.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 30000 });
  await expect(dialog).toContainText('import the source gallery before publishing');
  await expect(dialog.getByRole('button', { name: 'Prepare detail review' })).toHaveCount(0);
  await expect(dialog.locator('[data-gallery-thumbnail]')).toHaveCount(9);
  await dialog.getByRole('button', { name: 'View image 9', exact: true }).click();
  await expect(dialog).toContainText('9 / 9');
  await dialog.getByRole('button', { name: 'View image 1', exact: true }).click();
  await expect(dialog.locator('[data-quote-open]')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Ask about customization' })).toBeDisabled();
  await expect(dialog).toContainText('USD 7.89');
  await expect(dialog).toContainText('USD 7.00');
  await expect(dialog).toContainText('USD 6.00');
  await expect(dialog).toContainText('Page 1 of 2');
  await dialog.getByRole('button', { name: 'Next configurations' }).click();
  await expect(dialog).toContainText('Page 2 of 2');
  await expect(dialog.locator('[data-catalog-variant-selector] input')).toHaveCount(5);
  await expect(dialog.getByRole('button', { name: 'Next configurations' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Previous configurations' }).click();
  await expect(dialog).toContainText('Page 1 of 2');
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).first();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await dialog.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    expect(geometry.overflow).toBe(false);
    expect(geometry.width).toBeLessThanOrEqual(width);
    if (width >= 1024) expect(geometry.width).toBeGreaterThan(width * 0.85);
    await dialog.locator('[data-preview-scroll]').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(close).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Edit item' })).toBeInViewport();
    await dialog.locator('[data-preview-scroll]').evaluate((el) => {
      el.scrollTop = 0;
    });
    if (width === 1440 || width === 390)
      await dialog.screenshot({ path: info.outputPath(`shared-draft-preview-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(preview).toBeFocused();
  // A transient service error must allow retry without approving or losing the draft.
  let injected = false;
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON();
    if (!injected && body.action === 'catalogDetailApproval') {
      injected = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'UNAVAILABLE', message: 'Preview temporarily unavailable' },
        }),
      });
    } else await route.continue();
  });
  await preview.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry product preview' }).click();
  await expect(dialog.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 30000 });
  await close.click();
  // Edit must not revert to a contradictory legacy unavailable price after Preview works.
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
  const pricePreview = editor.getByRole('region', { name: 'Effective website pricing' });
  await expect(pricePreview).toContainText('USD 7.89');
  await expect(pricePreview).toContainText('USD 7.00');
  await expect(pricePreview).toContainText('USD 6.00');
  await expect(pricePreview).not.toContainText('Pricing unavailable');
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
  const after = await getDraft();
  expect(after.published).toBe(false);
  expect(after.imageIds).toBeUndefined();
  expect(after.catalogDetailPublication).toBeUndefined();
  expect(after.alibabaReviewPending).toBe(true);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((action) => ['prepare', 'review'].includes(action))).toBe(true);
  expect(errors).toEqual([]);
});

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
  // Classification must update the already-public immutable detail as well as
  // the admin row. Exercise the same bulk control the client asked for.
  for (const label of ['Misc', 'Headphones']) {
    let withdrawnDuringPreparation = false;
    if (label === 'Misc') {
      await page.route('**/api/admin', async (route) => {
        const body = route.request().postDataJSON();
        if (
          !withdrawnDuringPreparation &&
          body.action === 'catalogDetailApproval' &&
          body.data?.action === 'prepare'
        ) {
          // A separate real API request withdraws the product while the browser
          // is classifying it. Approval must not manufacture a republish command.
          withdrawnDuringPreparation = true;
          await adminAction(
            request,
            'update',
            { collection: 'products', id, values: { published: false } },
            session.token,
          );
        }
        await route.continue();
      });
    }
    await page.getByRole('checkbox', { name: 'Select all rows' }).check();
    await page
      .getByRole('combobox', { name: 'Website main category' })
      .and(page.locator('button'))
      .click();
    await page
      .getByRole('listbox', { name: 'Website main category' })
      .getByRole('option', { name: label, exact: true })
      .click();
    await page.getByRole('button', { name: 'Assign category', exact: true }).click();
    const committed = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/api/admin') || response.request().method() !== 'POST')
        return false;
      const command = response.request().postDataJSON();
      if (!['get', 'update'].includes(command.action) || command.data?.id !== id) return false;
      const body = await response.json();
      return body.ok && body.data?.catalogDetailPublication?.header?.categoryLabel === label;
    });
    await page.getByRole('button', { name: 'Confirm assignment' }).click();
    // This is the terminal read (or the old buggy republish response), not an
    // intermediate approved snapshot followed by an unnoticed publication write.
    expect((await (await committed).json()).data.published).toBe(label !== 'Misc');
    // Category refresh no longer sends a publication patch. Await the persisted
    // approval, not a stale status message from the previous batch.
    await expect
      .poll(
        async () => {
          const saved = await adminAction<CollectionDoc>(
            request,
            'get',
            { collection: 'products', id },
            session.token,
          );
          return saved.catalogDetailPublication;
        },
        { timeout: 30000 },
      )
      .toMatchObject({ state: 'approved', header: { categoryLabel: label } });
    await expect(page.getByRole('status')).toContainText('1 updated', { timeout: 30000 });
    const saved = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id },
      session.token,
    );
    expect(saved.published).toBe(label !== 'Misc');
    expect(saved.catalogDetailPublication).toMatchObject({
      state: 'approved',
      header: { categoryLabel: label },
    });
    if (label === 'Misc') {
      expect(withdrawnDuringPreparation).toBe(true);
      await page.unroute('**/api/admin');
      // Explicit operator intent, after proving category-only refresh kept it
      // private. Restore this disposable fixture for the remaining buyer journey.
      await adminAction(
        request,
        'update',
        { collection: 'products', id, values: { published: true } },
        session.token,
      );
    }
  }
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
  expect(response.status()).toBe(200);
  // The browser already decoded the response. Read the buyer-visible receipt,
  // then prove it through the real idempotent API and persisted Admin record.
  // A DevTools body lookup can fail even after the page decoded the receipt.
  const savedNotice = dialog.getByRole('status');
  await expect(savedNotice).toContainText('Inquiry saved. Reference:');
  const requestId = (await savedNotice.locator('span').innerText()).trim();
  expect(requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const saved = { ok: true, requestId };
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

import { expect, test } from '@playwright/test';
import { decodeCatalogDetailView } from '../../packages/shared/src/catalog/product-detail';
import { type CollectionDoc, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireAdminCredentialsWhenEnabled } from './helpers/env';
import { expectInquirySaved } from './helpers/inquiry-followup';
import { expectProductSaved } from './helpers/product-save';

const enabled = process.env.E2E_CATALOG_LIVE_ACCEPTANCE === '1';
const scope = process.env.E2E_CATALOG_ACCEPTANCE_SCOPE ?? 'full';
if (!['full', 'variant-media'].includes(scope)) throw new Error('Unknown live acceptance scope.');
// @skip-when explicit, audited live acceptance is not requested. Never skip on runtime failures.
test.skip(
  !enabled,
  'Explicit catalog live acceptance only; not a general production mutation suite.',
);
requireAdminCredentialsWhenEnabled(enabled, 'Catalog live acceptance');
if (
  enabled &&
  (e2e.siteUrl !== 'https://supplychainsai.com' ||
    e2e.apiUrl !== 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com' ||
    !process.env.CHANNEL_EXPECTED_RELEASE ||
    !e2e.allowMutation ||
    process.env.E2E_RECORD_ARTIFACTS === '1')
)
  throw new Error(
    'Live acceptance needs exact approved origins, expected SHA and no credential-bearing artifacts.',
  );

// Already public in the pre-release audit. Never publish a new draft to make a test pass.
const sampleIds = ['f15a8e4f-3f48-4021-ac3d-67bd1060836a', '0aa9d459-159c-4ffa-a5c0-db9a8e7c642f'];
test.describe.configure({ retries: 0 });
test('live release: approved categories, existing published galleries, real inquiry and Admin completion', async ({
  page,
  request,
}) => {
  // @skip-when a separately approved narrow media repair was explicitly selected.
  test.skip(scope !== 'full', 'Full historical remediation is outside the selected repair scope.');
  test.setTimeout(20 * 60 * 1000);
  const health = await adminAction<{ releaseId: string }>(request, 'health');
  expect(health.releaseId).toBe(process.env.CHANNEL_EXPECTED_RELEASE);
  const publicHealth = await request.get(`${e2e.apiUrl}/api/health`);
  expect((await publicHealth.json()).data.releaseId).toBe(process.env.CHANNEL_EXPECTED_RELEASE);
  const session = await loginAdmin(request);
  expect(await adminAction(request, 'inquiryCapabilities', undefined, session.token)).toEqual({
    enabled: true,
    notification: 'disabled',
  });
  const publicIds = async () => {
    const response = await request.get(`${e2e.apiUrl}/api/products?pageSize=100`);
    const data = (await response.json()).data;
    expect(data.total).toBeLessThanOrEqual(100);
    return data.items.map((p: { _id: string }) => p._id).sort();
  };
  const beforeIds = await publicIds();
  for (const id of sampleIds) expect(beforeIds).toContain(id);
  await page.goto('/login?returnTo=%2Fadmin');
  // Check the safe SSR contract BEFORE entering a real credential. A stale
  // cached login page must fail here, not fall back to native GET submission.
  await expect(page.locator('form')).toHaveAttribute('method', 'post');
  await expect(page.locator('form')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30000 });

  await page.getByRole('button', { name: 'Alibaba Sync', exact: true }).click();
  const categories = page.locator('section[aria-labelledby="category-assignment-heading"]');
  await categories
    .getByRole('button', { name: 'Install approved mapping rules', exact: true })
    .click();
  await expect(categories.locator('output')).toContainText('30 approved mapping rules', {
    timeout: 180000,
  });
  await expect(categories.getByRole('alert')).toHaveCount(0);
  await categories
    .getByRole('button', { name: 'Preview category assignments', exact: true })
    .click();
  await expect(categories.locator('output')).toContainText('Preview ready.', { timeout: 180000 });
  const apply = categories.getByRole('button', { name: /^Apply \d+ reviewed assignments$/ });
  const count = Number((await apply.innerText()).match(/\d+/)?.[0]);
  expect(Number.isSafeInteger(count)).toBe(true);
  expect(count).toBeLessThanOrEqual(302); // approved historical remediation scope
  console.log(`Category preview: ${count} eligible; published products will not change.`);
  if (count > 0) {
    await apply.click();
    await expect(categories.locator('output')).toContainText(
      '0 remaining. No products published.',
      { timeout: 600000 },
    );
    await expect(categories.getByRole('alert')).toHaveCount(0);
  }
  expect(await publicIds()).toEqual(beforeIds);

  // Actual raw-replay regressions, not synthetic products. These remain drafts:
  // inspect list/Edit/shared Preview without importing, saving or publishing.
  for (const sample of [
    {
      id: 'a5ab40df-d3ff-4baa-ad3a-1aacc4615448',
      summary: 'USD 7.75–9.00',
      detail: 'USD 7.75 – USD 9.00 per unit',
      mode: 'range',
    },
    {
      id: 'b8677602-2935-417d-a8fa-64fb377b9835',
      summary: 'USD 14.90',
      detail: 'USD 14.90 per unit',
      mode: 'fixed',
    },
  ]) {
    const before = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id: sample.id },
      session.token,
    );
    expect(before.published).toBe(false);
    expect(before.alibabaSourceReview).toMatchObject({
      minimumOrderQuantity: 2,
      primaryPricing: { mode: sample.mode },
    });
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder(/^Search name/).fill(String(before.name));
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: String(before.name) });
    await expect(row).toContainText(sample.summary);
    await expect(row).toContainText('2 (source)');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
    await expect(editor.getByRole('region', { name: 'Effective website pricing' })).toContainText(
      sample.summary,
    );
    await expect(editor.getByRole('region', { name: 'Effective website pricing' })).toContainText(
      'Source MOQ: 2',
    );
    await editor.getByRole('button', { name: 'Close editor' }).click();
    await row.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Product preview', exact: true });
    await expect(preview.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 120000 });
    await expect(preview).toContainText('Product-level quotes');
    await expect(preview).toContainText(sample.detail);
    await expect(preview).toContainText('Minimum order quantity: 2');
    await expect(preview.locator('[data-quote-open]')).toBeDisabled();
    await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
    const after = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id: sample.id },
      session.token,
    );
    for (const field of [
      'published',
      'name',
      'productFamily',
      'catalogPricingMode',
      'manualCatalogPricing',
      'unitPrice',
      'wholesalePrice',
      'moq',
      'imageIds',
      'descriptionImageIds',
    ])
      expect(after[field], `read-only preview preserved ${field}`).toEqual(before[field]);
  }
  expect(await publicIds()).toEqual(beforeIds);

  for (const id of sampleIds) {
    const before = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id },
      session.token,
    );
    expect(before.published).toBe(true);
    expect(typeof before.alibabaPrimarySourceKey).toBe('string');
    expect(Array.isArray(before.alibabaSourceImageUrls)).toBe(true);
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder(/^Search name/).fill(String(before.name));
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: String(before.name) })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await expect(page.getByLabel('Published', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Import source gallery', exact: true }).click();
    await expect(page.getByText(/images added\. Save to attach/)).toBeVisible({ timeout: 180000 });
    const imageErrors = page.getByText(/Source image \d+:|import stopped/);
    // Log only known diagnostic tokens, never full gateway responses, URLs or
    // credential-bearing admin artifacts. Partial success must still fail.
    const diagnostics = (await imageErrors.allTextContents()).map((message) =>
      message.match(
        /Source image \d+|Import rejected: [a-z-]+|Request failed \(\d+\)|import stopped/g,
      ),
    );
    expect(diagnostics, `Gallery admission failed for ${id}`).toEqual([]);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectProductSaved(page, 180000);
    const after = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id },
      session.token,
    );
    for (const field of [
      'published',
      'name',
      'productFamily',
      'unitPrice',
      'wholesalePrice',
      'moq',
    ])
      expect(after[field], `preserved ${field}`).toEqual(before[field]);
    expect(after.catalogDetailPublication).toMatchObject({
      state: 'approved',
      variantStorage: 'immutable-v1',
    });
    expect(Array.isArray(after.imageIds) && after.imageIds.length > 1).toBe(true);
    console.log(
      `Existing published sample ${id}: approved, gallery ${Array.isArray(after.imageIds) ? after.imageIds.length : 0}; manual values unchanged.`,
    );
    await page.goto(`/headphones/?id=${id}`);
    await expect(page.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-catalog-quote-conditions]')).toContainText('Website pricing');
    const publicDetail = await request.get(`${e2e.apiUrl}/api/products/${id}/detail?view=sections`);
    expect(publicDetail.ok()).toBe(true);
    const pricing = (await publicDetail.json()).data.websitePricing.pricing;
    if (pricing.mode === 'fixed' || pricing.mode === 'range') {
      const reference = page.locator('[data-quote-reference-price]');
      await expect(reference).toBeVisible();
      await expect(reference).toContainText(pricing.currency);
    }
    const generalGallery = page.getByRole('button', { name: /^View product gallery/ });
    if (await generalGallery.isVisible()) await generalGallery.click();
    const thumbnails = page.locator('[data-gallery-thumbnail]');
    await expect(thumbnails).toHaveCount(Array.isArray(after.imageIds) ? after.imageIds.length : 0);
    for (let index = 0; index < (await thumbnails.count()); index++) {
      await thumbnails.nth(index).click();
      await expect(thumbnails.nth(index)).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(
          () =>
            page
              .locator('[data-gallery-frame] img')
              .evaluate(
                (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
              ),
          { timeout: 30000 },
        )
        .toBe(true);
    }
    await thumbnails.first().click();
    // Explicit public-page screenshot only; never record login/session traces.
    await page.screenshot({ path: `output/catalog-live/public-${id}.png`, fullPage: true });
    await page.goto('/admin');
  }
  expect(await publicIds()).toEqual(beforeIds);
  await page.goto(`/headphones/?id=${sampleIds[0]}`);
  await expect(page.locator('[data-catalog-variant-selector]')).toBeVisible();
  // This approved live sample has one SKU: the actual UI uses radio chips for
  // <=12 variants, unlike the 21-SKU local pagination fixture's select control.
  await expect(page.locator('[data-catalog-variant-selector]').getByRole('radio')).toHaveCount(1);
  await page.locator('[data-catalog-variant-selector]').getByRole('radio').check();
  await page.locator('[data-quote-open]').click();
  const dialog = page.locator('[data-catalog-quote-sheet]');
  await dialog.getByLabel('Requested quantity', { exact: true }).fill('1000');
  await dialog.getByRole('button', { name: 'Continue to contact', exact: true }).click();
  await dialog.getByLabel('Contact name', { exact: true }).fill('CI release acceptance');
  await dialog.getByLabel('Email', { exact: true }).fill('catalog-acceptance@example.invalid');
  await dialog
    .getByLabel('Company', { exact: true })
    .fill(`TEST ONLY - ${process.env.CHANNEL_EXPECTED_RELEASE?.slice(0, 12)}`);
  await dialog.getByRole('combobox').scrollIntoViewIfNeeded();
  await dialog.getByRole('combobox').click();
  await dialog.getByRole('combobox').pressSequentially('Brazil', { delay: 50 });
  await page.getByRole('option', { name: /Brazil/ }).click();
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  const pending = page.waitForResponse(
    (r) => r.url().includes('/api/catalog-quote-requests') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Send inquiry', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const savedNotice = dialog.getByRole('status');
  await expect(savedNotice).toContainText('Inquiry saved. Reference:');
  const requestId = (await savedNotice.locator('span').innerText()).trim();
  expect(requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const receipt = { requestId };
  console.log(`Private test inquiry receipt: ${receipt.requestId}; email disabled.`);
  await page.goto('/admin');
  await page.getByRole('button', { name: /Product Inquiries/ }).click();
  await page.locator(`#inquiry-${receipt.requestId}`).click();
  await expect(page.getByRole('region', { name: 'Process inquiry' })).toContainText('Unprocessed');
  await page
    .getByLabel('Internal note', { exact: true })
    .fill('TEST ONLY: automated release acceptance; no real buyer, order or email.');
  await page.getByRole('combobox', { name: 'Next status', exact: true }).click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expectInquirySaved(page, 1, 'In progress');
  await page
    .getByLabel('Internal note', { exact: true })
    .fill('TEST ONLY: release acceptance completed. No commercial follow-up needed.');
  await page.getByRole('combobox', { name: 'Next status', exact: true }).click();
  await page.getByRole('option', { name: 'Completed', exact: true }).click();
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expectInquirySaved(page, 2, 'Completed');
  const persisted = await adminAction<{
    kind: string;
    item: { status: string; notification: string };
  }>(request, 'inquiry', { action: 'get', id: receipt.requestId }, session.token);
  expect(persisted.item).toMatchObject({ status: 'completed', notification: 'disabled' });
  expect(await publicIds()).toEqual(beforeIds);
});

test('live variant-media repair: exact retained raw → SKU-owned images → matching mobile colors', async ({
  page,
  request,
}) => {
  // @skip-when this exact product repair was not explicitly selected by the operator.
  test.skip(scope !== 'variant-media', 'Only the explicitly selected variant-media repair.');
  test.setTimeout(10 * 60 * 1000);
  const expectedRelease = process.env.CHANNEL_EXPECTED_RELEASE;
  expect((await adminAction<{ releaseId: string }>(request, 'health')).releaseId).toBe(
    expectedRelease,
  );
  expect((await (await request.get(`${e2e.apiUrl}/api/health`)).json()).data.releaseId).toBe(
    expectedRelease,
  );
  const session = await loginAdmin(request);
  const sync = async (action: string, data?: unknown) => {
    const response = await request.post(`${e2e.apiUrl}/api/alibaba-catalog-sync`, {
      data: { action, data, token: session.token },
      timeout: 180000,
    });
    const body = await response.json();
    // Never print an arbitrary authenticated backend response into CI logs.
    expect(response.status(), `Sync ${action} HTTP status`).toBe(200);
    expect(body.ok, `Sync ${action} result`).toBe(true);
    return body.data;
  };
  expect((await sync('health')).releaseId).toBe(expectedRelease);
  const id = '0aa9d459-159c-4ffa-a5c0-db9a8e7c642f';
  const sourceKey = 'fba5c0af145d21fac836a4ed4366798af6a87b080e6762ad4b7f3a5a8563be28';
  const expectedImages: Record<string, string> = {
    Black: 'https://sc04.alicdn.com/kf/Hdd76b413997a44cb91f594cc004237e8N.jpg',
    White: 'https://sc04.alicdn.com/kf/Hbb64fd6a2fd041c2879fe6bd84472d31U.jpg',
    Pink: 'https://sc04.alicdn.com/kf/H445a300485e148579071381c766d0aacj.jpg',
  };
  const getProduct = () =>
    adminAction<CollectionDoc>(request, 'get', { collection: 'products', id }, session.token);
  const publicIds = async () => {
    const body = await (await request.get(`${e2e.apiUrl}/api/products?pageSize=100`)).json();
    expect(body.data.total).toBeLessThanOrEqual(100);
    return body.data.items.map((p: { _id: string }) => p._id).sort();
  };
  const beforeIds = await publicIds();
  const before = await getProduct();
  expect(beforeIds).toContain(id);
  expect(before.published).toBe(true);
  expect(before.alibabaPrimarySourceKey).toBe(sourceKey);
  const protectedFields = [
    'published',
    'name',
    'productFamily',
    'subcategory',
    'catalogPricingMode',
    'manualCatalogPricing',
    'unitPrice',
    'wholesalePrice',
    'moq',
    'imageIds',
    'descriptionImageIds',
  ];
  const preserveManual = async () => {
    const current = await getProduct();
    for (const field of protectedFields)
      expect(current[field], `preserved ${field}`).toEqual(before[field]);
    expect(await publicIds()).toEqual(beforeIds);
  };
  // No fresh supplier API request: verify and replay exactly one retained raw payload.
  const dry = await sync('replaySourceObservations', { mode: 'dry-run', sourceKey, limit: 1 });
  expect(dry).toMatchObject({
    ready: true,
    manifestReady: true,
    done: true,
    totalSourceProducts: 1,
    failures: [],
    counts: { sourceProducts: 1, variants: 3 },
  });
  const applied = await sync('replaySourceObservations', {
    mode: 'apply',
    sourceKey,
    limit: 1,
    manifestId: dry.manifestId,
    expectedPageHash: dry.pageHash,
    expectedTotalSourceProducts: 1,
  });
  expect(applied).toMatchObject({ ready: true, done: true, applied: 1, failures: [] });
  await preserveManual();
  await page.goto('/login?returnTo=%2Fadmin');
  await expect(page.locator('form')).toHaveAttribute('method', 'post');
  await expect(page.locator('form')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30000 });
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByPlaceholder(/^Search name/).fill(String(before.name));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: String(before.name) });
  await row.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Product preview', exact: true });
  await expect(preview.locator('[data-shared-catalog-detail]')).toBeVisible({ timeout: 120000 });
  const readReview = () =>
    adminAction<{
      detail: unknown;
      previewMedia: { variantSources: { id: string; sources: string[] }[] };
    }>(
      request,
      'catalogDetailApproval',
      { action: 'review', productId: id, includePreviewMedia: true },
      session.token,
    );
  const rawReview = await readReview();
  const rawDetail = decodeCatalogDetailView(rawReview.detail);
  expect(rawDetail.ok).toBe(true);
  if (!rawDetail.ok) throw new Error('Invalid review detail');
  for (const variant of rawDetail.value.variants.items) {
    const color = variant.options.find((o) => o.name.toLowerCase() === 'color')?.value ?? '';
    expect(expectedImages[color]).toBeDefined();
    expect(rawReview.previewMedia.variantSources.find((v) => v.id === variant.id)?.sources).toEqual(
      [expectedImages[color]],
    );
    await preview.getByRole('radio', { name: color, exact: true }).check();
    await expect(preview.locator('[data-variant-gallery]')).toContainText(
      `Configuration photos — ${color}`,
    );
    await expect
      .poll(
        () =>
          preview
            .locator('[data-gallery-frame] img')
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        { timeout: 30000 },
      )
      .toBe(true);
  }
  await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
  await preserveManual();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectProductSaved(page, 180000);
  await preserveManual();
  const approved = await readReview();
  const approvedDetail = decodeCatalogDetailView(approved.detail);
  if (!approvedDetail.ok) throw new Error('Invalid approved review detail');
  const response = await request.get(`${e2e.apiUrl}/api/products/${id}/detail?view=sections`);
  expect(response.ok()).toBe(true);
  const decoded = decodeCatalogDetailView((await response.json()).data);
  if (!decoded.ok) throw new Error('Invalid public detail');
  expect(decoded.value.images).toHaveLength(6);
  expect(decoded.value.variants.total).toBe(3);
  const ownedByColor = new Map<string, string>();
  for (const v of decoded.value.variants.items) {
    const color = v.options.find((o) => o.name.toLowerCase() === 'color')?.value ?? '';
    expect(v.images).toHaveLength(1);
    expect(v.images[0]).toMatch(/^\/api\/images\//);
    expect(approvedDetail.value.variants.items.find((item) => item.id === v.id)?.images).toEqual(
      v.images,
    );
    const url = v.images[0];
    if (!url) throw new Error('Missing owned SKU photo');
    ownedByColor.set(color, url);
  }
  expect(new Set(ownedByColor.values()).size).toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/headphones/?id=${id}`);
  for (const color of ['Black', 'White', 'Pink', 'Black', 'Pink']) {
    await page.getByRole('radio', { name: color, exact: true }).check();
    const hero = page.locator('[data-gallery-frame] img');
    await expect(hero).toHaveAttribute('src', new RegExp(`${ownedByColor.get(color)}$`));
    await expect
      .poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
        timeout: 30000,
      })
      .toBe(true);
    await page
      .locator('[data-variant-gallery]')
      .screenshot({ path: `output/catalog-live/public-sku-${color.toLowerCase()}.png` });
  }
  await page.getByRole('button', { name: 'View product gallery (6)', exact: true }).click();
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(6);
  await expect(page.getByRole('radio', { name: 'Pink', exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await preserveManual();
  console.log(
    'Exact SY-T11 retained raw repaired; 3 distinct SKU-owned images, 6 general images; manual values and publication set unchanged. No email or inquiry created.',
  );
});

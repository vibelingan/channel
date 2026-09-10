import { expect, test } from '@playwright/test';
import { type CollectionDoc, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireAdminCredentialsWhenEnabled } from './helpers/env';
import { expectInquirySaved } from './helpers/inquiry-followup';

const enabled = process.env.E2E_CATALOG_LIVE_ACCEPTANCE === '1';
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
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 180000 });
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

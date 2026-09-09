import { expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import {
  e2e,
  requireAdminCredentialsWhenEnabled,
  requireCatalogLocalSeedWhenEnabled,
} from './helpers/env';

test.describe.configure({ mode: 'serial' });

test.describe('Admin catalog lifecycle', () => {
  // @skip-when the disposable local catalog lane is off. Spec DISCOVERY (`test:e2e --list`)
  // and PR CI must stay green without mutation credentials, so this skips on a STATIC
  // config flag only. Once the flag IS set, missing credentials, a non-loopback URL, or a
  // mismatched temporary database FAIL below — they never skip.
  test.skip(
    !e2e.allowMutation,
    'Run pnpm test:e2e:catalog-admin-local (sets E2E_ALLOW_MUTATION=1) for catalog mutations.',
  );
  requireAdminCredentialsWhenEnabled(e2e.allowMutation, 'catalog Admin mutation suite');
  requireCatalogLocalSeedWhenEnabled(e2e.allowMutation);

  test('linked pricing: no-op edit, manual override, public price, reload and restore use real persistence', async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const session = await loginAdmin(request);
    const list = await adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      { collection: 'products', search: 'SonicAir Move', page: 1, pageSize: 20 },
      session.token,
    );
    const id = list.items[0]?._id;
    expect(id).toBeTruthy();
    const read = () =>
      adminAction<CollectionDoc>(request, 'get', { collection: 'products', id }, session.token);
    const before = await read();
    const openEditor = async () => {
      await page.goto('/admin');
      await page.getByRole('button', { name: 'Products', exact: true }).click();
      await page.getByPlaceholder(/^Search name/).fill('SonicAir Move');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page
        .getByRole('row')
        .filter({ hasText: 'SonicAir Move' })
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
    };
    const policy = async (label: string) => {
      await page.locator('button#catalogPricingMode-trigger').click();
      await page
        .getByRole('listbox', { name: 'Website pricing', exact: true })
        .getByRole('option', { name: label, exact: true })
        .click();
    };
    const save = async () => {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await page.goto('/login?returnTo=%2Fadmin');
    await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);
    await openEditor();
    await expect(page.getByRole('region', { name: 'Effective website pricing' })).toContainText(
      '$5.70',
    );
    await expect(page.getByRole('region', { name: 'Effective website pricing' })).toContainText(
      '$3.80',
    );
    await save();
    expect((await read()).manualCatalogPricing).toEqual(before.manualCatalogPricing);
    expect((await read()).catalogPricingMode).toEqual(before.catalogPricingMode);
    await openEditor();
    await policy('Manual website pricing');
    const price = page.getByLabel('Unit price (USD)', { exact: true }).first();
    await expect(price).toHaveValue('5.70');
    for (const invalid of ['', '-1', 'NaN', '1.234', '9007199254740993']) {
      await price.fill(invalid);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    }
    await price.fill('6.20');
    await page.getByLabel('Maximum quantity', { exact: true }).first().fill('500');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Maximum quantity', { exact: true }).first().fill('499');
    await save();
    const saved = await read();
    expect(saved.catalogPricingMode).toBe('manual');
    expect(saved.manualCatalogPricing).toMatchObject({
      currency: 'USD',
      tiers: [
        { minQuantity: 2, maxQuantity: 499, unitAmountMinor: 620 },
        { minQuantity: 500, maxQuantity: 999, unitAmountMinor: 500 },
        { minQuantity: 1000, unitAmountMinor: 380 },
      ],
    });
    expect(saved.alibabaCatalogPricing).toEqual(before.alibabaCatalogPricing);
    await page.goto('/products/item/?slug=local-linked-pricing');
    await expect(page.locator('[data-effective-pricing="manual-tiered"]')).toContainText('$6.20');
    await expect(page.locator('[data-effective-pricing]')).not.toContainText('$5.70');
    const schema = await page.locator('script[type="application/ld+json"]').last().textContent();
    expect(schema).toContain('6.20');
    await openEditor();
    await expect(page.getByLabel('Unit price (USD)', { exact: true }).first()).toHaveValue('6.20');
    await page.setViewportSize({ width: 390, height: 844 });
    const formBounds = await page.getByRole('dialog').locator('form').boundingBox();
    expect(formBounds).not.toBeNull();
    expect((formBounds?.x ?? 0) + (formBounds?.width ?? 1000)).toBeLessThanOrEqual(390);
    await expect(page.getByRole('heading', { name: 'Website price preview' })).toBeVisible();
    await expect(page.getByText('Unsaved changes are not live.', { exact: false })).toBeVisible();
    await page.getByRole('region', { name: 'Effective website pricing' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/manual-price-mobile.png' });
    await policy('Follow Alibaba pricing');
    await save();
    expect((await read()).manualCatalogPricing).toEqual(saved.manualCatalogPricing);
    expect((await read()).catalogPricingMode).toBe('source');
    await page.goto('/products/item/?slug=local-linked-pricing');
    await expect(page.locator('[data-effective-pricing="alibaba"]')).toContainText('$5.70');
    await expect(page.locator('[data-effective-pricing]')).not.toContainText('$6.20');
    await expect(page.locator('[data-alibaba-tiers]')).toContainText('1000+');
    expect(errors).toEqual([]);
  });

  test('selected main-category assignment and mixed publication use real API persistence', async ({
    page,
    request,
  }) => {
    const health = await request.get(`${e2e.apiUrl}/api/health`);
    const healthBody = await health.json();
    expect(healthBody.data?.mode).toBe('local');
    expect(healthBody.data?.db).toBe(e2e.catalogLocalDb);
    const session = await loginAdmin(request);
    const prefix = `${e2e.runId} Batch`;
    const seeds = await adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      { collection: 'products', page: 1, pageSize: 100 },
      session.token,
    );
    const imageIds = seeds.items.find(
      (row) => Array.isArray(row.imageIds) && row.imageIds.length,
    )?.imageIds;
    expect(Array.isArray(imageIds)).toBe(true);
    const ids: string[] = [];
    for (const [label, images] of [
      ['Ready', imageIds],
      ['Needs image', []],
    ] as const) {
      const row = await adminAction<CollectionDoc>(
        request,
        'create',
        {
          collection: 'products',
          values: {
            name: `${prefix} ${label}`,
            productFamily: 'headphones',
            category: 'wired',
            description: 'Disposable built-site batch acceptance.',
            published: false,
            imageIds: images,
            unitPrice: 5.7,
          },
        },
        session.token,
      );
      ids.push(row._id);
    }
    await page.goto('/login?returnTo=%2Fadmin');
    await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder(/^Search name/).fill(prefix);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Select row', exact: true })).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Select all rows' }).check();
    // Wait for the enhanced control, not the native fallback that is hidden
    // during hydration. No forced click or arbitrary sleep.
    await page
      .getByRole('combobox', { name: 'Website main category' })
      .and(page.locator('button'))
      .click();
    await page
      .getByRole('listbox', { name: 'Website main category' })
      .getByRole('option', { name: 'Misc', exact: true })
      .click();
    await page.getByRole('button', { name: 'Assign category', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm assignment' }).click();
    await expect(page.getByRole('status')).toContainText('2 updated');
    for (const id of ids) {
      const saved = await adminAction<CollectionDoc>(
        request,
        'get',
        { collection: 'products', id },
        session.token,
      );
      expect(saved).toMatchObject({
        productFamily: 'misc',
        category: '',
        published: false,
        unitPrice: 5.7,
      });
    }
    await page.getByRole('checkbox', { name: 'Select all rows' }).check();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('1 published · 1 need attention');
    await expect(page.getByRole('alert')).toContainText('image');
    const [ready, invalid] = await Promise.all(
      ids.map((id) =>
        adminAction<CollectionDoc>(request, 'get', { collection: 'products', id }, session.token),
      ),
    );
    expect(ready?.published).toBe(true);
    expect(invalid?.published).toBe(false);
    const publicResponse = await request.get(
      `${e2e.apiUrl}/api/products?search=${encodeURIComponent(prefix)}`,
    );
    const publicBody = await publicResponse.json();
    expect(publicBody.data.items.map((row: CollectionDoc) => row._id)).toEqual([ids[0]]);
    await page.reload();
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByPlaceholder(/^Search name/).fill(`${prefix} Ready`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: `${prefix} Ready` })
      .getByRole('button', { name: 'Published', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await adminAction<CollectionDoc>(
              request,
              'get',
              { collection: 'products', id: ids[0] },
              session.token,
            )
          ).published,
      )
      .toBe(false);
  });

  test('admin assigns a website category from the unclassified queue and the API keeps the product private', async ({
    page,
    request,
  }) => {
    const session = await loginAdmin(request);
    const name = `${e2e.runId} Unclassified Clock`;
    const draft = await adminAction<CollectionDoc>(
      request,
      'create',
      {
        collection: 'products',
        values: { name, description: 'Disposable classification acceptance.', published: false },
      },
      session.token,
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/login?returnTo=%2Fadmin');
    await page.getByLabel('Email', { exact: true }).fill(e2e.adminEmail);
    await page.getByLabel('Password', { exact: true }).fill(e2e.adminPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);
    await page.goto('/admin?productFamily=unclassified');
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    const search = page.getByPlaceholder(/^Search name/);
    await search.fill(name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await page.screenshot({ path: 'output/playwright/category-queue-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('combobox', { name: 'Product family', exact: true })).toContainText(
      'Needs classification',
    );
    await page.screenshot({ path: 'output/playwright/category-queue-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('button#productFamily-trigger').click();
    await page
      .getByRole('listbox', { name: 'Website main category', exact: true })
      .getByRole('option', { name: 'Misc', exact: true })
      .click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await page
      .getByRole('group', { name: 'Product family', exact: true })
      .getByRole('button', { name: 'Misc', exact: true })
      .click();
    await expect(row).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    const saved = await adminAction<CollectionDoc>(
      request,
      'get',
      { collection: 'products', id: draft._id },
      session.token,
    );
    expect(saved.productFamily).toBe('misc');
    expect(saved.published).toBe(false);
    expect(saved).not.toHaveProperty('category');
    expect(errors).toEqual([]);
  });

  test('creates, moves, publishes, unpublishes, and archives one disposable-DB product', async ({
    page,
    request,
  }) => {
    const health = await request.get(`${e2e.apiUrl}/api/health`);
    const healthBody = (await health.json()) as {
      ok?: boolean;
      data?: { mode?: unknown; db?: unknown };
    };
    expect(health.ok()).toBe(true);
    expect(healthBody.data?.mode).toBe('local');
    expect(healthBody.data?.db).toBe(e2e.catalogLocalDb);
    const session = await loginAdmin(request);
    const slug = `${e2e.runId}-catalog-product`;
    const skuCode = `${e2e.runId}-catalog-sku`;
    const name = `${e2e.runId} Catalog Product`;
    const legacyImageId = `${e2e.runId}-catalog-image`;
    let productId = '';

    const draft = await adminAction<CollectionDoc>(
      request,
      'create',
      {
        collection: 'products',
        values: {
          name,
          productFamily: 'ai-gadgets',
          slug,
          skuCode,
          description: 'Created by the catalog Admin lifecycle E2E and removed in cleanup.',
          published: false,
          archived: false,
        },
      },
      session.token,
    );
    productId = draft._id;
    expect(draft.published).toBe(false);
    expect(draft.productFamily).toBe('ai-gadgets');

    const aiGadgets = await adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      {
        collection: 'products',
        productFamily: 'ai-gadgets',
        page: 1,
        pageSize: 10,
        search: name,
      },
      session.token,
    );
    expect(aiGadgets.items.map((item) => item._id)).toContain(productId);

    await expect(
      adminAction(
        request,
        'create',
        {
          collection: 'products',
          values: {
            name: `${name} duplicate`,
            productFamily: 'toys',
            slug,
            skuCode: `${skuCode}-2`,
          },
        },
        session.token,
      ),
    ).rejects.toThrow(/already in use|CONFLICT/i);

    const moved = await adminAction<CollectionDoc>(
      request,
      'update',
      {
        collection: 'products',
        id: productId,
        values: { productFamily: 'toys', imageIds: [legacyImageId] },
      },
      session.token,
    );
    expect(moved.productFamily).toBe('toys');
    expect(moved.imageIds).toEqual([legacyImageId]);

    const toys = await adminAction<ListResult<CollectionDoc>>(
      request,
      'list',
      { collection: 'products', productFamily: 'toys', page: 1, pageSize: 10, search: name },
      session.token,
    );
    expect(toys.items.map((item) => item._id)).toContain(productId);

    const published = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: productId, values: { published: true } },
      session.token,
    );
    expect(published.published).toBe(true);

    await expect
      .poll(async () => {
        const response = await request.get(
          `${e2e.apiUrl}/api/products/slug/${encodeURIComponent(slug)}`,
          { headers: { Origin: e2e.siteUrl } },
        );
        return response.status();
      })
      .toBe(200);
    await page.goto(`/products/item/?slug=${encodeURIComponent(slug)}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.locator('[data-product-media="fallback"]')).toBeVisible();

    const unpublished = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: productId, values: { published: false } },
      session.token,
    );
    expect(unpublished.published).toBe(false);
    const hidden = await request.get(
      `${e2e.apiUrl}/api/products/slug/${encodeURIComponent(slug)}`,
      { headers: { Origin: e2e.siteUrl } },
    );
    expect(hidden.status()).toBe(404);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Product not found.' })).toBeVisible();

    const archived = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: productId, values: { archived: true } },
      session.token,
    );
    expect(archived.archived).toBe(true);
    expect(archived.published).toBe(false);
    // Products are intentionally archive-only. The E2E_CATALOG_LOCAL_SEED guard
    // binds this suite to MIU 22's disposable DB, which is deleted after the run.
  });

  test('publishes a slugless tier-priced product and clears Headphones subcategory on move', async ({
    page,
    request,
  }) => {
    const session = await loginAdmin(request);
    const name = `${e2e.runId} Slugless Tiered Toy`;
    const imageId = `${e2e.runId}-tiered-image`;
    const manualCatalogPricing = {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [
        { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
        { minQuantity: 13, unitAmountMinor: 11_831 },
      ],
    };

    const draft = await adminAction<CollectionDoc>(
      request,
      'create',
      {
        collection: 'products',
        values: {
          name,
          productFamily: 'headphones',
          category: 'office',
          description: 'Disposable slugless product with quantity pricing.',
          published: false,
          archived: false,
        },
      },
      session.token,
    );
    expect(draft).not.toHaveProperty('skuCode');
    expect(draft).not.toHaveProperty('slug');
    expect(draft.category).toBe('office');

    const moved = await adminAction<CollectionDoc>(
      request,
      'update',
      {
        collection: 'products',
        id: draft._id,
        values: {
          productFamily: 'toys',
          imageIds: [imageId],
          moq: 1,
          unitPrice: 199,
          wholesalePrice: 177,
          manualCatalogPricing,
        },
      },
      session.token,
    );
    expect(moved.productFamily).toBe('toys');
    expect(moved.category).toBe('');
    expect(moved.unitPrice).toBe(199);
    expect(moved.wholesalePrice).toBe(177);
    expect(moved.manualCatalogPricing).toEqual(manualCatalogPricing);

    const published = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: draft._id, values: { published: true } },
      session.token,
    );
    expect(published.published).toBe(true);

    const publicResponse = await request.get(
      `${e2e.apiUrl}/api/products?productFamily=toys&pageSize=48`,
      { headers: { Origin: e2e.siteUrl } },
    );
    expect(publicResponse.ok()).toBe(true);
    const publicBody = (await publicResponse.json()) as {
      data?: { items?: CollectionDoc[] };
    };
    const projected = publicBody.data?.items?.find((item) => item._id === draft._id);
    expect(projected).toBeDefined();
    expect(projected).not.toHaveProperty('category');
    expect(projected).not.toHaveProperty('skuCode');
    expect(projected).not.toHaveProperty('slug');
    expect(projected?.unitPrice).toBe(199);
    expect(projected?.wholesalePrice).toBe(177);
    expect(projected?.manualCatalogPricing).toEqual(manualCatalogPricing);

    await page.goto('/toys/');
    const card = page.getByRole('button', { name: new RegExp(name) });
    await expect(card).toContainText('From $118.31');
    await card.click();
    const detail = page.locator(`[data-product-detail="${draft._id}"]`);
    await expect(detail.locator('[data-manual-tier-pricing]')).toContainText('1–12');
    await expect(detail.locator('[data-manual-tier-pricing]')).toContainText('13+');
    await expect(detail.getByText('$134.18', { exact: true })).toHaveCount(1);
    await expect(detail.getByText('$118.31', { exact: true })).toHaveCount(1);
    await expect(detail.getByText('$199.00', { exact: true })).toHaveCount(0);
    await expect(detail.getByText('$177.00', { exact: true })).toHaveCount(0);

    const unpublished = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: draft._id, values: { published: false } },
      session.token,
    );
    expect(unpublished.published).toBe(false);
    const archived = await adminAction<CollectionDoc>(
      request,
      'update',
      { collection: 'products', id: draft._id, values: { archived: true } },
      session.token,
    );
    expect(archived.archived).toBe(true);
  });
});

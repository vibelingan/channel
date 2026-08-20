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
});

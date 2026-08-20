import { expect, test } from '@playwright/test';
import { type CollectionDoc, type ListResult, adminAction, loginAdmin } from './helpers/admin-api';
import { e2e, requireCatalogLocalSeedWhenEnabled } from './helpers/env';

const expectedFamilies = {
  headphones: [
    'AuraBeat Pro Studio',
    'AuraBeat Classic',
    'WorkComm Mono',
    'WorkComm Duo',
    'SonicAir 5',
    'SonicAir Move',
  ],
  'ai-gadgets': ['Local Demo VisionClip AI Camera', 'Local Demo Pocket Translator'],
  toys: ['Local Demo BuildBot Kit', 'Local Demo Magnetic Tiles'],
  misc: ['Local Demo USB-C Travel Hub', 'Local Demo Desktop Aroma Light'],
} as const;

requireCatalogLocalSeedWhenEnabled(true);

test('disposable local seed exposes four exact families and legacy Headphones safely', async ({
  page,
  request,
}) => {
  const health = await request.get(`${e2e.apiUrl}/api/health`);
  const healthBody = (await health.json()) as {
    data?: { mode?: unknown; db?: unknown };
  };
  expect(health.ok()).toBe(true);
  expect(healthBody.data?.mode).toBe('local');
  expect(healthBody.data?.db).toBe(e2e.catalogLocalDb);

  const session = await loginAdmin(request);
  const rawProducts = await adminAction<ListResult<CollectionDoc>>(
    request,
    'list',
    { collection: 'products', page: 1, pageSize: 100 },
    session.token,
  );
  const legacy = rawProducts.items.filter(
    (product) =>
      !Object.hasOwn(product, 'productFamily') &&
      typeof product.category === 'string' &&
      ['wired', 'office', 'bluetooth'].includes(product.category),
  );
  expect(legacy.map((product) => product.name)).toEqual(['AuraBeat Pro Studio']);
  expect(rawProducts.total).toBe(12);
  for (const [family, expectedNames] of Object.entries(expectedFamilies)) {
    const rawFamily = rawProducts.items.filter((product) => {
      if (product.productFamily === family) return true;
      return (
        family === 'headphones' &&
        !Object.hasOwn(product, 'productFamily') &&
        typeof product.category === 'string' &&
        ['wired', 'office', 'bluetooth'].includes(product.category)
      );
    });
    expect(rawFamily.map((product) => product.name).sort()).toEqual([...expectedNames].sort());
  }
  const rawNonHeadphones = rawProducts.items.filter(
    (product) => product.productFamily !== 'headphones' && Object.hasOwn(product, 'productFamily'),
  );
  expect(rawNonHeadphones).toHaveLength(6);
  for (const product of rawNonHeadphones) {
    expect(Array.isArray(product.imageIds) ? product.imageIds.length : 0).toBeLessThanOrEqual(9);
    expect(product).not.toHaveProperty('vipPrice');
    expect(product).not.toHaveProperty('video');
    expect(product).not.toHaveProperty('videoUrl');
  }

  for (const [family, expectedNames] of Object.entries(expectedFamilies)) {
    const response = await request.get(
      `${e2e.apiUrl}/api/products?productFamily=${encodeURIComponent(family)}&pageSize=48`,
      { headers: { Origin: e2e.siteUrl } },
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      ok: boolean;
      data?: { items?: CollectionDoc[]; total?: number };
    };
    expect(body.ok).toBe(true);
    const products = body.data?.items ?? [];
    expect(products.map((product) => product.name).sort()).toEqual([...expectedNames].sort());
    expect(body.data?.total).toBe(expectedNames.length);
    for (const product of products) {
      expect(product.productFamily).toBe(family);
      expect(Array.isArray(product.images) ? product.images.length : 0).toBeLessThanOrEqual(9);
      expect(product).not.toHaveProperty('imageIds');
      expect(product).not.toHaveProperty('vipPrice');
      expect(product).not.toHaveProperty('archived');
      expect(product).not.toHaveProperty('createdAt');
      expect(product).not.toHaveProperty('updatedAt');
      expect(product).not.toHaveProperty('video');
      expect(product).not.toHaveProperty('videoUrl');
    }
  }

  await page.goto('/products/item/?slug=local-demo-visionclip-ai-camera');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Local Demo VisionClip AI Camera' }),
  ).toBeVisible();
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(2);
  await expect(page.getByText(/VIP|video/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Request a Quote' }).first()).toHaveAttribute(
    'href',
    '/#oem-inquiry',
  );
});

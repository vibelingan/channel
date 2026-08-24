import type {
  PublicProduct,
  CatalogPage as SharedCatalogPage,
} from '@vibelingan-channel/shared/catalog';
import type {
  AlibabaCatalogPricing,
  CatalogPage,
  Product,
} from '../../islands/shop/catalog-types.ts';

export function createPublicProduct(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return {
    _id: 'public-headphones-1',
    name: 'Public Headphones',
    productFamily: 'headphones',
    category: 'office',
    ...overrides,
  };
}

export function createOldestHeadphonesPublicProduct(
  overrides: Partial<PublicProduct> = {},
): PublicProduct {
  return createPublicProduct({
    _id: 'legacy-headphones-1',
    name: 'Legacy Wired Headphones',
    productFamily: 'headphones',
    category: 'wired',
    ...overrides,
  });
}

export function createCurrentPublicProducts(): PublicProduct[] {
  return [
    createPublicProduct(),
    createPublicProduct({
      _id: 'ai-gadget-1',
      name: 'AI Gadget',
      productFamily: 'ai-gadgets',
      category: undefined,
    }),
    createPublicProduct({
      _id: 'toy-1',
      name: 'Learning Toy',
      productFamily: 'toys',
      category: undefined,
    }),
    createPublicProduct({
      _id: 'misc-1',
      name: 'Cable Organizer',
      productFamily: 'misc',
      category: undefined,
    }),
  ];
}

export function createPublicCatalogPage(
  overrides: Partial<SharedCatalogPage<PublicProduct>> = {},
): SharedCatalogPage<PublicProduct> {
  return {
    items: [createPublicProduct()],
    total: 1,
    page: 1,
    pageSize: 48,
    ...overrides,
  };
}

/**
 * Default fixture is an UNLINKED (legacy) product — the Alibaba fields flip
 * the render branch, so they live in the dedicated linked factory below.
 */
export function createProduct(overrides: Partial<Product> = {}): Product {
  return {
    _id: 'product-1',
    name: 'Factory Headphones',
    category: 'headphones',
    series: 'Factory Series',
    modName: 'FT-100',
    modType: 'Over-ear',
    description: 'Complete typed product fixture.',
    productCode: 'FT-100-BLK',
    moq: 500,
    unitPrice: 12.5,
    wholesalePrice: 10,
    vipPrice: 8,
    inventory: 1000,
    clearancePrice: 9,
    imageIds: ['image-1'],
    images: ['/api/images/image-1'],
    ...overrides,
  };
}

export function createAlibabaCatalogPricing(
  overrides: Partial<AlibabaCatalogPricing> = {},
): AlibabaCatalogPricing {
  return {
    schemaVersion: 'alibaba-catalog-pricing-v1',
    source: 'alibaba',
    currency: 'USD',
    mode: 'fixed',
    amountMinor: 250,
    sourceMoq: 100,
    sourceUpdatedAt: '2026-08-01T02:00:00.000Z',
    syncedAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

/** An Alibaba-LINKED product: every additive field populated per the public projection. */
export function createAlibabaLinkedProduct(overrides: Partial<Product> = {}): Product {
  return createProduct({
    alibabaPrimarySourceKey: 'a'.repeat(64),
    alibabaCatalogPricing: createAlibabaCatalogPricing(),
    alibabaSourceStatus: 'available',
    alibabaSourceLastSyncedAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  });
}

export function createCatalogPage(overrides: Partial<CatalogPage> = {}): CatalogPage {
  return {
    items: [createProduct()],
    total: 1,
    page: 1,
    pageSize: 48,
    ...overrides,
  };
}

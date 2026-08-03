import type { CatalogPage, Product } from '../../islands/shop/catalog-types.ts';

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

export function createCatalogPage(overrides: Partial<CatalogPage> = {}): CatalogPage {
  return {
    items: [createProduct()],
    total: 1,
    page: 1,
    pageSize: 48,
    ...overrides,
  };
}

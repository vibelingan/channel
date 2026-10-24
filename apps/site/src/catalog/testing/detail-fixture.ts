import type { CatalogProductDetail } from '@vibelingan-channel/shared/catalog-detail';

/** Synthetic public DTO only: no provider accounts, raw objects or supplier URLs. */
export function detailFixture(total = 3, page = 1, pageSize = 50): CatalogProductDetail {
  const offset = (page - 1) * pageSize;
  return {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'canonical-product',
    name: 'Headset',
    revision: 'approved-r1',
    images: ['/api/images/image-1'],
    facts: [{ name: 'Connector', value: 'USB-C' }],
    offers: [],
    variants: {
      items: Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) }, (_, i) => ({
        id: `variant-${offset + i + 1}`,
        options: [{ name: 'Color', value: `Color ${offset + i + 1}` }],
        inventory: { state: 'unknown' as const },
        images: [],
        offers: [],
      })),
      total,
      page,
      pageSize,
      hasMore: offset + pageSize < total,
    },
  };
}

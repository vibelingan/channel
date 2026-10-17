import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  ADMIN_PRODUCT_LIST_MARKER,
  ADMIN_PRODUCT_LIST_VIEW,
} from '@vibelingan-channel/shared/admin-product-list';

/** Fixed server allowlist, derived from the existing list and classification consumers. */
export const ADMIN_PRODUCT_LIST_FIELDS = [
  '_id',
  'name',
  'productFamily',
  'category',
  'subcategoryIds',
  'published',
  'archived',
  'updatedAt',
  'createdAt',
  'skuCode',
  'modName',
  'moq',
  'unitPrice',
  'wholesalePrice',
  'catalogPricingMode',
  'manualCatalogPricing',
  'alibabaPrimarySourceKey',
  'alibabaSourceProductId',
  'alibabaSourceCategoryId',
  'alibabaCatalogPricing',
  'alibabaSourceReview',
  'alibabaReviewPending',
  'alibabaReviewReason',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
  'alibabaSourceImageUrls',
  'imageIds',
] as const;
export const ADMIN_PRODUCT_LIST_PROJECTION: Readonly<Record<string, boolean>> = Object.freeze({
  ...Object.fromEntries(ADMIN_PRODUCT_LIST_FIELDS.map((field) => [field, true])),
  'alibabaAutoPhotos.gallery': true,
});

export function usesProductListView(query: {
  collection: string;
  catalogListView?: unknown;
}): boolean {
  if (query.catalogListView === undefined) return false;
  if (query.collection !== 'products' || query.catalogListView !== ADMIN_PRODUCT_LIST_VIEW)
    throw Error('Invalid admin product list view');
  return true;
}

/** JSON DTO copy: exclude future fields and prevent mutation of nested stored data. */
export function projectProductListRow(doc: CollectionDoc): CollectionDoc {
  const row: Record<string, unknown> = {
    _id: doc._id,
    [ADMIN_PRODUCT_LIST_MARKER]: ADMIN_PRODUCT_LIST_VIEW,
  };
  for (const field of ADMIN_PRODUCT_LIST_FIELDS)
    if (field !== '_id' && Object.hasOwn(doc, field)) row[field] = doc[field];
  const auto = doc.alibabaAutoPhotos;
  if (auto && typeof auto === 'object' && !Array.isArray(auto) && Object.hasOwn(auto, 'gallery'))
    row.alibabaAutoPhotos = { gallery: Reflect.get(auto, 'gallery') };
  // Functions orchestration does not provide structuredClone; records use the JSON contract.
  return JSON.parse(JSON.stringify(row));
}

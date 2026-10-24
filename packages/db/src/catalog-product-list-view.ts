import type { CollectionDoc, ListResult } from '@vibelingan-channel/shared';
import {
  ADMIN_PRODUCT_LIST_CORE_INCOMPLETE,
  ADMIN_PRODUCT_LIST_LIMITED,
  ADMIN_PRODUCT_LIST_MARKER,
  ADMIN_PRODUCT_LIST_PAGE_MAX_BYTES,
  ADMIN_PRODUCT_LIST_ROW_MAX_BYTES,
  ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH,
  ADMIN_PRODUCT_LIST_VIEW,
  fitsJsonBudget,
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
  if (fitsJsonBudget(row, ADMIN_PRODUCT_LIST_ROW_MAX_BYTES, ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH))
    return cloneRow(row);
  return limitedProductListRow(doc);
}

const CORE_FIELDS = [
  'published',
  'archived',
  'updatedAt',
  'productFamily',
  'category',
  'subcategoryIds',
  'alibabaReviewPending',
  'alibabaReviewReason',
  'alibabaPrimarySourceKey',
  'alibabaSourceCategoryId',
] as const;
function limitedProductListRow(doc: CollectionDoc): CollectionDoc {
  let coreIncomplete = false;
  let name = '';
  if (typeof doc.name === 'string' && doc.name.length > 0) {
    for (const char of doc.name) {
      if (name.length + char.length > 160) break;
      name += char;
    }
    if (name !== doc.name) {
      name += '…';
      coreIncomplete = true;
    }
  } else {
    name = 'Product';
    coreIncomplete = true;
  }
  const row: Record<string, unknown> = {
    _id: doc._id,
    [ADMIN_PRODUCT_LIST_MARKER]: ADMIN_PRODUCT_LIST_VIEW,
    [ADMIN_PRODUCT_LIST_LIMITED]: true,
    name,
  };
  if (
    typeof doc._id !== 'string' ||
    !doc._id ||
    !fitsJsonBudget(row, ADMIN_PRODUCT_LIST_ROW_MAX_BYTES - 512, ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH)
  )
    throw Error('The product list contains an unreadable record identity.');
  const copy = (field: string, value: unknown) => {
    if (value === undefined) return;
    if (
      fitsJsonBudget(value, 2048) &&
      fitsJsonBudget(
        { ...row, [field]: value },
        ADMIN_PRODUCT_LIST_ROW_MAX_BYTES - 512,
        ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH,
      )
    )
      row[field] = value;
    else coreIncomplete = true;
  };
  for (const field of CORE_FIELDS) if (Object.hasOwn(doc, field)) copy(field, doc[field]);
  // Category suggestions compare the nested and direct source IDs independently.
  const review = doc.alibabaSourceReview;
  if (
    review &&
    typeof review === 'object' &&
    !Array.isArray(review) &&
    Object.hasOwn(review, 'sourceCategoryId')
  )
    copy('alibabaSourceReview', { sourceCategoryId: Reflect.get(review, 'sourceCategoryId') });
  if (coreIncomplete) row[ADMIN_PRODUCT_LIST_CORE_INCOMPLETE] = true;
  if (!fitsJsonBudget(row, ADMIN_PRODUCT_LIST_ROW_MAX_BYTES, ADMIN_PRODUCT_LIST_ROW_MAX_DEPTH))
    throw Error('The product list summary could not be bounded.');
  return cloneRow(row);
}
function cloneRow(row: Record<string, unknown>): CollectionDoc {
  // Functions orchestration does not provide structuredClone; records use the JSON contract.
  return JSON.parse(JSON.stringify(row));
}
export function projectProductListResult(
  result: ListResult<CollectionDoc>,
): ListResult<CollectionDoc> {
  if (
    !Number.isSafeInteger(result.pageSize) ||
    result.pageSize < 1 ||
    result.pageSize > 100 ||
    result.items.length > result.pageSize
  )
    throw Error('The product list page was not confirmed.');
  const page: ListResult<CollectionDoc> = {
    ...result,
    items: result.items.map(projectProductListRow),
    catalogListView: ADMIN_PRODUCT_LIST_VIEW,
  };
  if (!fitsJsonBudget({ ok: true, data: page }, ADMIN_PRODUCT_LIST_PAGE_MAX_BYTES))
    throw Error('The product list page could not be bounded.');
  return page;
}

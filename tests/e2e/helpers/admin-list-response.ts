import { projectProductListResult } from '../../../packages/db/src/catalog-product-list-view.ts';
import { ADMIN_PRODUCT_LIST_VIEW } from '../../../packages/shared/src/catalog/admin-product-list.ts';
import type { CollectionDoc, ListResult } from '../../../packages/shared/src/index.ts';

/** Use the server's projection for mocked list replies; editor reads keep the complete record. */
export function adminListResponse(
  requestData: unknown,
  items: CollectionDoc[],
  total = items.length,
): ListResult<CollectionDoc> {
  const query = requestData && typeof requestData === 'object' ? requestData : {};
  const requestedPage = Reflect.get(query, 'page');
  const requestedSize = Reflect.get(query, 'pageSize');
  const result = {
    items,
    total,
    page: typeof requestedPage === 'number' ? requestedPage : 1,
    pageSize: typeof requestedSize === 'number' ? requestedSize : 20,
  };
  return Reflect.get(query, 'collection') === 'products' &&
    Reflect.get(query, 'catalogListView') === ADMIN_PRODUCT_LIST_VIEW
    ? projectProductListResult(result)
    : result;
}

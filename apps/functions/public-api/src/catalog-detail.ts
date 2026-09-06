/** Approved canonical detail only. Never reads source observations or evidence. */
import { get, list } from '@vibelingan-channel/db';
import { type ApiResult, err, ok } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  type CatalogProductDetail,
  decodeCatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';

export async function getProductDetail(
  productId: string,
  page = 1,
  pageSize = 50,
  expectedRevision?: string,
): Promise<ApiResult<CatalogProductDetail>> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    return err('VALIDATION_ERROR', 'Invalid variant pagination.');
  }
  const product = await get('products', productId);
  if (
    !product ||
    product.published !== true ||
    (Object.hasOwn(product, 'archived') && product.archived !== false)
  ) {
    return err('NOT_FOUND', 'Item not found');
  }
  const approved = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!approved.success || approved.data.header._id !== productId) {
    return err('NOT_FOUND', 'Detail not available');
  }
  const { revision, header, variantCount } = approved.data;
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return err('CONFLICT', 'Detail changed. Reload from the first page.');
  }
  const rows = await list({
    collection: 'productVariants',
    page,
    pageSize,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'productId', op: 'eq', value: productId },
        { field: 'catalogDetailRevision', op: 'eq', value: revision },
        { field: 'archived', op: 'ne', value: true },
      ],
    },
    sort: [
      { field: 'catalogDetailPosition', dir: 'asc' },
      { field: '_id', dir: 'asc' },
    ],
  });
  // A partial approval/revision change must never masquerade as a complete page.
  const current = await get('products', productId);
  const currentApproval = CatalogDetailPublicationSchema.safeParse(
    current?.catalogDetailPublication,
  );
  if (
    current?.published !== true ||
    (Object.hasOwn(current, 'archived') && current.archived !== false) ||
    !currentApproval.success ||
    currentApproval.data.revision !== revision ||
    rows.total !== variantCount ||
    rows.items.some(
      (row) =>
        (Object.hasOwn(row, 'archived') && row.archived !== false) ||
        typeof row.catalogDetailApproved !== 'object' ||
        row.catalogDetailApproved === null ||
        !('id' in row.catalogDetailApproved) ||
        row.catalogDetailApproved.id !== row._id,
    )
  ) {
    return err('CONFLICT', 'Detail changed. Reload from the first page.');
  }
  const decoded = decodeCatalogProductDetail({
    ...header,
    revision,
    variants: {
      items: rows.items.map((row) => row.catalogDetailApproved),
      total: variantCount,
      page,
      pageSize,
      hasMore: page * pageSize < variantCount,
    },
  });
  return decoded.ok ? ok(decoded.value) : err('INTERNAL_ERROR', 'Invalid approved detail.');
}

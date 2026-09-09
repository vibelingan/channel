/** Approved canonical detail only. Never reads source observations or evidence. */
import { get, list } from '@vibelingan-channel/db';
import { approvedVariantDocumentId } from '@vibelingan-channel/db/catalog-detail-storage';
import { type ApiResult, err, ok } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  type CatalogDetailView,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';

export async function getProductDetail(
  productId: string,
  page = 1,
  pageSize = 50,
  expectedRevision?: string,
  structured = false,
  sections = false,
): Promise<ApiResult<CatalogDetailView>> {
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
  const immutable = approved.data.variantStorage === 'immutable-v1';
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return err('CONFLICT', 'Detail changed. Reload from the first page.');
  }
  const rows = await list({
    collection: immutable ? 'catalogDetailVariants' : 'productVariants',
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
    currentApproval.data.header._id !== productId ||
    currentApproval.data.variantStorage !== approved.data.variantStorage ||
    currentApproval.data.revision !== revision ||
    rows.total !== variantCount ||
    rows.items.length !== Math.max(0, Math.min(pageSize, variantCount - (page - 1) * pageSize)) ||
    rows.items.some(
      (row, index) =>
        (immutable &&
          (typeof row.variantId !== 'string' ||
            row._id !== approvedVariantDocumentId(productId, revision, row.variantId) ||
            row.catalogDetailPosition !== (page - 1) * pageSize + index)) ||
        (Object.hasOwn(row, 'archived') && row.archived !== false) ||
        typeof row.catalogDetailApproved !== 'object' ||
        row.catalogDetailApproved === null ||
        !('id' in row.catalogDetailApproved) ||
        row.catalogDetailApproved.id !== (immutable ? row.variantId : row._id),
    )
  ) {
    return err('CONFLICT', 'Detail changed. Reload from the first page.');
  }
  const decoded = decodeCatalogDetailView({
    ...header,
    ...(structured && approved.data.content
      ? {
          schemaVersion: 'catalog-product-detail-v2',
          content: approved.data.content,
        }
      : {}),
    ...(sections && approved.data.content && approved.data.noteBlocks
      ? {
          schemaVersion: 'catalog-product-detail-v3',
          content: approved.data.content,
          noteBlocks: approved.data.noteBlocks,
        }
      : {}),
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

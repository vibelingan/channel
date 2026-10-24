/** Approved canonical detail only. Never reads source observations or evidence. */
import { get, list } from '@vibelingan-channel/db';
import { approvedVariantDocumentId } from '@vibelingan-channel/db/catalog-detail-storage';
import { type ApiResult, err, ok } from '@vibelingan-channel/shared';
import {
  type CatalogDetailView,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  CATALOG_DETAIL_PAGE_MAX_BYTES,
  readCatalogDetailPageSize,
} from '@vibelingan-channel/shared/catalog-detail-pagination';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';

export async function getProductDetail(
  productId: string,
  page = 1,
  requestedPageSize = 50,
  expectedRevision?: string,
  structured = false,
  sections = false,
  descriptionMedia = false,
  boundedPagination = false,
): Promise<ApiResult<CatalogDetailView>> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > 50 ||
    !Number.isSafeInteger((page - 1) * requestedPageSize)
  ) {
    return err('VALIDATION_ERROR', 'Invalid variant pagination.');
  }
  let pageSize = requestedPageSize;
  const product = await get('products', productId);
  if (
    !product ||
    product.published !== true ||
    (Object.hasOwn(product, 'archived') && product.archived !== false)
  ) {
    return err('NOT_FOUND', 'Item not found');
  }
  // The same rule the list uses (DEC-1); this route exists only when the
  // detail feature is on. No approved version → the site shows the row page.
  const approved = resolvePublicVersion(product, { detailEnabled: true });
  if (approved.kind !== 'approved' || approved.publication.header._id !== productId) {
    return err('NOT_FOUND', 'Detail not available');
  }
  const { revision, header, variantCount } = approved.publication;
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return err('CONFLICT', 'Detail changed. Reload from the first page.');
  }
  const storedPageSize = readCatalogDetailPageSize(product, revision);
  if (boundedPagination) {
    if (storedPageSize === null) return err('INTERNAL_ERROR', 'Invalid approved pagination.');
    if (page > 1 && pageSize > storedPageSize)
      return err('CONFLICT', 'Detail changed. Reload from the first page.');
    pageSize = Math.min(pageSize, storedPageSize);
  }

  if (page > Math.max(1, Math.ceil(variantCount / pageSize)))
    return err('VALIDATION_ERROR', 'Invalid variant pagination.');
  const immutable = approved.publication.variantStorage === 'immutable-v1';
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
  const currentApproval = resolvePublicVersion(current, { detailEnabled: true });
  if (
    current?.published !== true ||
    (Object.hasOwn(current, 'archived') && current.archived !== false) ||
    currentApproval.kind !== 'approved' ||
    currentApproval.publication.header._id !== productId ||
    currentApproval.publication.variantStorage !== approved.publication.variantStorage ||
    currentApproval.publication.revision !== revision ||
    (boundedPagination && readCatalogDetailPageSize(current, revision) !== storedPageSize) ||
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
  // Old, already open clients use strict v1/v2/v3 decoders. New fields require opt-in.
  const { descriptionImages: _descriptionImages, ...legacyHeader } = header;
  const decoded = decodeCatalogDetailView({
    ...(descriptionMedia ? header : legacyHeader),
    ...(structured && approved.publication.content
      ? {
          schemaVersion: 'catalog-product-detail-v2',
          content: approved.publication.content,
        }
      : {}),
    ...(sections && approved.publication.content && approved.publication.noteBlocks
      ? {
          schemaVersion: 'catalog-product-detail-v3',
          content: approved.publication.content,
          noteBlocks: approved.publication.noteBlocks,
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
  if (!decoded.ok) return err('INTERNAL_ERROR', 'Invalid approved detail.');
  const result = ok(decoded.value);
  if (Buffer.byteLength(JSON.stringify(result)) > CATALOG_DETAIL_PAGE_MAX_BYTES)
    return err('INTERNAL_ERROR', 'Approved detail exceeds its page budget.');
  return result;
}

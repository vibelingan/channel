/** Private immutable storage identity. Public/RFQ IDs remain canonical variant IDs. */
import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';

export function approvedVariantDocumentId(productId: string, revision: string, variantId: string) {
  return createHash('sha256')
    .update(JSON.stringify([productId, revision, variantId]))
    .digest('hex');
}

export function approvedVariantTarget(
  product: CollectionDoc | null | undefined,
  variantId: string,
) {
  const approval = CatalogDetailPublicationSchema.safeParse(product?.catalogDetailPublication);
  if (!product || !approval.success || approval.data.header._id !== product._id) return null;
  const immutable = approval.data.variantStorage === 'immutable-v1';
  return {
    collection: immutable ? 'catalogDetailVariants' : 'productVariants',
    id: immutable
      ? approvedVariantDocumentId(product._id, approval.data.revision, variantId)
      : variantId,
    variantId,
    productId: product._id,
    revision: approval.data.revision,
    immutable,
  };
}

/** Check the storage binding before translating its private row key into a canonical identity. */
export function canonicalApprovedVariant(
  target: ReturnType<typeof approvedVariantTarget>,
  row: CollectionDoc | null | undefined,
): CollectionDoc | null {
  if (
    !target ||
    !row ||
    row._id !== target.id ||
    row.productId !== target.productId ||
    row.catalogDetailRevision !== target.revision ||
    (target.immutable && row.variantId !== target.variantId)
  )
    return null;
  return { ...row, _id: target.variantId };
}

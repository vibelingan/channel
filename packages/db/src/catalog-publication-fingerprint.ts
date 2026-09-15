import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';

/** Website content and source generation, excluding publication toggles and audit timestamps. */
export function publicationContentFingerprint(product: CollectionDoc): string {
  const fields = [
    '_id',
    'name',
    'description',
    'imageIds',
    'productFamily',
    'category',
    'catalogPricingMode',
    'manualCatalogPricing',
    'unitPrice',
    'wholesalePrice',
    'moq',
    'alibabaPrimarySourceKey',
    'detailSourceReady',
    'detailSourceOwner',
    'detailSourceRevision',
  ];
  if (product.descriptionImageIds !== undefined) fields.push('descriptionImageIds');
  return createHash('sha256')
    .update(JSON.stringify(fields.map((key) => [key, product[key] ?? null])))
    .digest('hex');
}

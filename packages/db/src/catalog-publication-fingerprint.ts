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
  // The admin's configuration photo choices are approved content too (DEC-20).
  if (product.configurationPhotos !== undefined) fields.push('configurationPhotos');
  // A manual product's facts come from its spec fields (MIU-27); a later edit
  // must be approved again. Synced fingerprints stay as they were (MIU-29).
  if (
    typeof product.detailSourceOwner === 'string' &&
    product.detailSourceOwner.startsWith('manual:')
  )
    fields.push('skuCode', 'series', 'modName', 'modType');
  return createHash('sha256')
    .update(JSON.stringify(fields.map((key) => [key, product[key] ?? null])))
    .digest('hex');
}

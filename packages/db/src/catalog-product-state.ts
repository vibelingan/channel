/** Product input versions. Preparation outputs and approved snapshots are not inputs. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { isProductFamily } from '@vibelingan-channel/shared';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';

const contentFields = [
  'name',
  'description',
  'imageIds',
  'descriptionImageIds',
  'configurationPhotos',
  'alibabaPhotosPending',
  'alibabaAutoPhotos',
  'supplierDecisions',
  'productFamily',
  'category',
  'catalogPricingMode',
  'manualCatalogPricing',
  'unitPrice',
  'wholesalePrice',
  'moq',
  'skuCode',
  'series',
  'modName',
  'modType',
  'alibabaPrimarySourceKey',
  'alibabaPrimaryOfferKey',
  'alibabaPinnedOfferKey',
  'alibabaCatalogPricing',
  'alibabaSourceImageUrls',
  'alibabaDescriptionImageUrls',
  'alibabaSourceReview',
  'alibabaSourceStatus',
  'alibabaSourcePublicDigest',
] as const;
const classificationFields = ['productFamily', 'category', 'subcategoryIds'] as const;
const versions = [
  'catalogContentGeneration',
  'catalogLifecycleVersion',
  'catalogClassificationRevision',
] as const;

const serverOutputs = [
  'catalogPreparationState',
  'catalogPreparationPolicy',
  'catalogPreparationReport',
  'catalogDetailPagination',
] as const;

export class CatalogProductStateError extends Error {}
export function isCatalogProductVersionField(field: string): boolean {
  return versions.some((key) => key === field);
}
export function isCatalogProductManagedField(field: string): boolean {
  return isCatalogProductVersionField(field) || serverOutputs.some((key) => key === field);
}
const versionLabels = {
  catalogContentGeneration: 'catalog content generation',
  catalogLifecycleVersion: 'catalog lifecycle version',
  catalogClassificationRevision: 'catalog classification revision',
} as const;

/** Validate stored counters before any transaction writes; legacy absence/null is zero. */
export function assertCatalogProductVersions(product: CollectionDoc | null): void {
  for (const key of versions) counter(product, key);
}

export function advanceCatalogProduct(
  before: CollectionDoc | null,
  proposed: CollectionDoc,
  now: string,
  forceContent = false,
): CollectionDoc {
  if (before && before._id !== proposed._id)
    throw new CatalogProductStateError('Product identity changed while advancing its state');
  assertCatalogProductVersions(before);
  const next: CollectionDoc = { ...proposed, updatedAt: monotonicProductTime(before, now) };
  // These fields belong to the write layer, never to a form or provider patch.
  for (const key of [...versions, ...serverOutputs]) {
    if (before && Object.hasOwn(before, key)) next[key] = before[key];
    else delete next[key];
  }
  const contentChanged =
    !before ||
    forceContent ||
    fingerprint(before, contentFields) !== fingerprint(next, contentFields);
  const classificationChanged =
    !before ||
    fingerprint(before, classificationFields) !== fingerprint(next, classificationFields);
  const lifecycleChanged =
    !before ||
    (before.published === true) !== (next.published === true) ||
    (before.archived === true) !== (next.archived === true);
  if (!contentChanged && before) {
    for (const field of ['detailSourceReady', 'catalogPreparationState'] as const) {
      if (Object.hasOwn(before, field)) next[field] = before[field];
      else delete next[field];
    }
  }
  if (contentChanged) {
    next.catalogContentGeneration = before ? increment(before, 'catalogContentGeneration') : 0;
    next.catalogPreparationState = 'stale';
    next.detailSourceReady = false;
  }
  if (classificationChanged)
    next.catalogClassificationRevision = before
      ? increment(before, 'catalogClassificationRevision')
      : 0;
  if (lifecycleChanged)
    next.catalogLifecycleVersion = before ? increment(before, 'catalogLifecycleVersion') : 0;
  return next;
}

export function monotonicProductTime(before: CollectionDoc | null, now: string): string {
  const previous =
    typeof before?.updatedAt === 'string' ? Date.parse(before.updatedAt) : Number.NaN;
  const current = Date.parse(now);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous < current) return now;
  const next = new Date(previous + 1);
  if (!Number.isFinite(next.getTime()))
    throw new CatalogProductStateError('Product timestamp is exhausted');
  return next.toISOString();
}

export function catalogProductContentDigest(product: CollectionDoc): string {
  return fingerprint(product, contentFields);
}

function fingerprint(product: CollectionDoc, fields: readonly string[]): string {
  return alibabaPricingFingerprint(
    Object.fromEntries(fields.map((key) => [key, inputValue(product, key)])),
  );
}
function inputValue(product: CollectionDoc, key: string): unknown {
  const value = product[key];
  if (key === 'alibabaPhotosPending' && (value === undefined || value === null || value === false))
    return false;
  if (
    key === 'category' &&
    isProductFamily(product.productFamily) &&
    product.productFamily !== 'headphones'
  )
    return null;
  if (
    ['alibabaPrimarySourceKey', 'alibabaPrimaryOfferKey', 'alibabaPinnedOfferKey'].includes(key) &&
    (value === '' || value == null)
  )
    return null;
  return key === 'alibabaCatalogPricing' ? pricingInput(value) : value;
}
function counter(product: CollectionDoc | null, field: (typeof versions)[number]): number {
  const value = product?.[field] ?? 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new CatalogProductStateError(`Invalid ${versionLabels[field]}`);
  return value;
}
function increment(product: CollectionDoc, field: (typeof versions)[number]): number {
  const value = counter(product, field);
  if (value === Number.MAX_SAFE_INTEGER)
    throw new CatalogProductStateError(`Exhausted ${versionLabels[field]}`);
  return value + 1;
}

function pricingInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { syncedAt: _capturedAt, ...pricing } = value as Record<string, unknown>;
  return pricing;
}

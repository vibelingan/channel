import type { CollectionDoc } from '@vibelingan-channel/shared';

export type AlibabaSourcePricing =
  | { mode: 'fixed'; currency: string; amountMinor: number; minimumOrderQuantity?: number }
  | {
      mode: 'range';
      currency: string;
      minimumAmountMinor: number;
      maximumAmountMinor: number;
      minimumOrderQuantity?: number;
    }
  | {
      mode: 'tiered';
      currency: string;
      minimumOrderQuantity?: number;
      tiers: Array<{
        minimumQuantity: number;
        maximumQuantity?: number;
        unitAmountMinor: number;
      }>;
    }
  | { mode: 'negotiable'; currency?: string; minimumOrderQuantity?: number }
  | { mode: 'unavailable'; minimumOrderQuantity?: number };

export interface AlibabaSourceReviewView {
  schemaVersion: 'alibaba-source-review-v1';
  provider: 'alibaba';
  externalProductId: string;
  sourceCategoryId?: string;
  sourceCategoryName?: string;
  sourceUpdatedAt?: string;
  sourceListingStatus: 'published' | 'draft' | 'missing' | 'unknown';
  variantCount: number;
  offerCount: number;
  modelNumbers: string[];
  optionNames: string[];
  minimumOrderQuantity?: number;
  primaryPricing?: AlibabaSourcePricing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || isSafePositiveInteger(value);
}

function isCurrency(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 12
  );
}

function decodePricing(value: unknown): AlibabaSourcePricing | null {
  if (!isRecord(value) || typeof value.mode !== 'string') return null;
  const commonKeys = ['mode', 'minimumOrderQuantity'] as const;
  if (!isOptionalPositiveInteger(value.minimumOrderQuantity)) return null;
  switch (value.mode) {
    case 'fixed':
      if (
        !hasOnlyKeys(value, [...commonKeys, 'currency', 'amountMinor']) ||
        !isCurrency(value.currency) ||
        !isSafeNonNegativeInteger(value.amountMinor)
      ) {
        return null;
      }
      return value as AlibabaSourcePricing;
    case 'range':
      if (
        !hasOnlyKeys(value, [
          ...commonKeys,
          'currency',
          'minimumAmountMinor',
          'maximumAmountMinor',
        ]) ||
        !isCurrency(value.currency) ||
        !isSafeNonNegativeInteger(value.minimumAmountMinor) ||
        !isSafeNonNegativeInteger(value.maximumAmountMinor) ||
        value.minimumAmountMinor > value.maximumAmountMinor
      ) {
        return null;
      }
      return value as AlibabaSourcePricing;
    case 'tiered': {
      if (
        !hasOnlyKeys(value, [...commonKeys, 'currency', 'tiers']) ||
        !isCurrency(value.currency) ||
        !Array.isArray(value.tiers) ||
        value.tiers.length === 0 ||
        value.tiers.length > 20
      ) {
        return null;
      }
      let previousMaximum = 0;
      for (const rawTier of value.tiers) {
        if (
          !isRecord(rawTier) ||
          !hasOnlyKeys(rawTier, ['minimumQuantity', 'maximumQuantity', 'unitAmountMinor']) ||
          !isSafePositiveInteger(rawTier.minimumQuantity) ||
          !isSafeNonNegativeInteger(rawTier.unitAmountMinor) ||
          (rawTier.maximumQuantity !== undefined &&
            (!isSafePositiveInteger(rawTier.maximumQuantity) ||
              rawTier.maximumQuantity < rawTier.minimumQuantity)) ||
          rawTier.minimumQuantity <= previousMaximum
        ) {
          return null;
        }
        previousMaximum = rawTier.maximumQuantity ?? Number.MAX_SAFE_INTEGER;
      }
      return value as AlibabaSourcePricing;
    }
    case 'negotiable':
      if (
        !hasOnlyKeys(value, [...commonKeys, 'currency']) ||
        (value.currency !== undefined && !isCurrency(value.currency))
      ) {
        return null;
      }
      return value as AlibabaSourcePricing;
    case 'unavailable':
      return hasOnlyKeys(value, commonKeys) ? (value as AlibabaSourcePricing) : null;
    default:
      return null;
  }
}

const REVIEW_KEYS = [
  'schemaVersion',
  'provider',
  'externalProductId',
  'sourceCategoryId',
  'sourceCategoryName',
  'sourceUpdatedAt',
  'sourceListingStatus',
  'variantCount',
  'offerCount',
  'modelNumbers',
  'optionNames',
  'minimumOrderQuantity',
  'primaryPricing',
] as const;

/** Decode source-controlled stored data before any admin component renders it. */
export function decodeAlibabaSourceReview(value: unknown): AlibabaSourceReviewView | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, REVIEW_KEYS) ||
    value.schemaVersion !== 'alibaba-source-review-v1' ||
    value.provider !== 'alibaba' ||
    typeof value.externalProductId !== 'string' ||
    value.externalProductId.length > 256 ||
    (value.sourceCategoryId !== undefined && typeof value.sourceCategoryId !== 'string') ||
    (value.sourceCategoryName !== undefined && typeof value.sourceCategoryName !== 'string') ||
    (value.sourceUpdatedAt !== undefined &&
      (typeof value.sourceUpdatedAt !== 'string' ||
        Number.isNaN(Date.parse(value.sourceUpdatedAt)))) ||
    !['published', 'draft', 'missing', 'unknown'].includes(String(value.sourceListingStatus)) ||
    !isSafeNonNegativeInteger(value.variantCount) ||
    !isSafeNonNegativeInteger(value.offerCount) ||
    !Array.isArray(value.modelNumbers) ||
    value.modelNumbers.length > 100 ||
    !value.modelNumbers.every((entry) => typeof entry === 'string' && entry.length <= 256) ||
    !Array.isArray(value.optionNames) ||
    value.optionNames.length > 100 ||
    !value.optionNames.every((entry) => typeof entry === 'string' && entry.length <= 256) ||
    !isOptionalPositiveInteger(value.minimumOrderQuantity)
  ) {
    return null;
  }
  const primaryPricing =
    value.primaryPricing === undefined ? undefined : decodePricing(value.primaryPricing);
  if (value.primaryPricing !== undefined && primaryPricing === null) return null;
  return {
    schemaVersion: 'alibaba-source-review-v1',
    provider: 'alibaba',
    externalProductId: value.externalProductId,
    ...(typeof value.sourceCategoryId === 'string'
      ? { sourceCategoryId: value.sourceCategoryId }
      : {}),
    ...(typeof value.sourceCategoryName === 'string'
      ? { sourceCategoryName: value.sourceCategoryName }
      : {}),
    ...(typeof value.sourceUpdatedAt === 'string'
      ? { sourceUpdatedAt: value.sourceUpdatedAt }
      : {}),
    sourceListingStatus:
      value.sourceListingStatus as AlibabaSourceReviewView['sourceListingStatus'],
    variantCount: value.variantCount,
    offerCount: value.offerCount,
    modelNumbers: [...value.modelNumbers],
    optionNames: [...value.optionNames],
    ...(typeof value.minimumOrderQuantity === 'number'
      ? { minimumOrderQuantity: value.minimumOrderQuantity }
      : {}),
    ...(primaryPricing === undefined || primaryPricing === null ? {} : { primaryPricing }),
  };
}

function money(currency: string, amountMinor: number): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

export function formatAlibabaSourcePricing(value: unknown): string {
  const pricing = decodePricing(value);
  if (pricing === null) return '—';
  const moq = pricing.minimumOrderQuantity;
  switch (pricing.mode) {
    case 'fixed':
      return `${money(pricing.currency, pricing.amountMinor)} / unit${moq ? ` · from ${moq}` : ''}`;
    case 'range':
      return `${money(pricing.currency, pricing.minimumAmountMinor)}–${(
        pricing.maximumAmountMinor / 100
      ).toFixed(2)} / unit${moq ? ` · from ${moq}` : ''}`;
    case 'tiered': {
      const amounts = pricing.tiers.map((tier) => tier.unitAmountMinor);
      return `${money(pricing.currency, Math.min(...amounts))}–${(
        Math.max(...amounts) / 100
      ).toFixed(2)} / unit · tiered${moq ? ` from ${moq}` : ''}`;
    }
    case 'negotiable':
      return `Negotiable${pricing.currency ? ` (${pricing.currency})` : ''}${moq ? ` · from ${moq}` : ''}`;
    case 'unavailable':
      return `Unavailable${moq ? ` · MOQ ${moq}` : ''}`;
  }
}

export type ProductReviewCell = 'identity' | 'category' | 'model' | 'variants' | 'moq' | 'pricing';

export function productReviewCellValue(
  doc: Pick<CollectionDoc, string>,
  cell: ProductReviewCell,
): string {
  const review = decodeAlibabaSourceReview(doc.alibabaSourceReview);
  switch (cell) {
    case 'identity':
      return typeof doc.skuCode === 'string' && doc.skuCode.trim() !== ''
        ? doc.skuCode
        : (review?.externalProductId ?? '—');
    case 'category':
      return review?.sourceCategoryName ?? review?.sourceCategoryId ?? '—';
    case 'model':
      return typeof doc.modName === 'string' && doc.modName.trim() !== ''
        ? doc.modName
        : review?.modelNumbers.join(', ') || '—';
    case 'variants':
      return review ? `${review.variantCount} variants · ${review.offerCount} offers` : '—';
    case 'moq':
      return typeof doc.moq === 'number' && Number.isFinite(doc.moq)
        ? String(doc.moq)
        : review?.minimumOrderQuantity === undefined
          ? '—'
          : String(review.minimumOrderQuantity);
    case 'pricing':
      if (typeof doc.unitPrice === 'number' && Number.isFinite(doc.unitPrice)) {
        return `Website USD ${doc.unitPrice.toFixed(2)} / unit`;
      }
      return formatAlibabaSourcePricing(review?.primaryPricing);
  }
}

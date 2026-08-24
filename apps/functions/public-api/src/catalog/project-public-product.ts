import {
  normalizeProductSlug,
  normalizeSkuCode,
  validateManualCatalogPricing,
} from '@vibelingan-channel/shared';
import type { PublicProduct } from '@vibelingan-channel/shared/catalog';
import { normalizePublicProduct } from '@vibelingan-channel/shared/catalog/normalize-public-product';

const RECOVERABLE_OPTIONAL_FIELDS = new Set([
  'alibabaCatalogPricing',
  'alibabaPrimarySourceKey',
  'alibabaSourceLastSyncedAt',
  'alibabaSourceStatus',
  'images',
  'manualCatalogPricing',
  'skuCode',
  'slug',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omitFields(
  source: Record<string, unknown>,
  fields: Iterable<string>,
): Record<string, unknown> {
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(source).filter(([field]) => !omitted.has(field)));
}

function sanitizeKnownOptionalFields(row: Record<string, unknown>): Record<string, unknown> {
  let candidate = { ...row };
  if (Object.hasOwn(candidate, 'slug')) {
    const slug = normalizeProductSlug(candidate.slug);
    if (slug === null) candidate = omitFields(candidate, ['slug']);
    else candidate.slug = slug;
  }
  if (Object.hasOwn(candidate, 'skuCode')) {
    const skuCode = normalizeSkuCode(candidate.skuCode);
    if (skuCode === null) candidate = omitFields(candidate, ['skuCode']);
    else candidate.skuCode = skuCode;
  }
  if (Object.hasOwn(candidate, 'manualCatalogPricing')) {
    const pricing = validateManualCatalogPricing(candidate.manualCatalogPricing);
    if (pricing.ok) candidate.manualCatalogPricing = pricing.value;
    else candidate = omitFields(candidate, ['manualCatalogPricing']);
  }
  return candidate;
}

export function projectPublicProduct(row: unknown): PublicProduct | null {
  if (!isRecord(row)) return null;
  const candidate = sanitizeKnownOptionalFields(row);
  const normalized = normalizePublicProduct(candidate);
  if (normalized.ok) return normalized.value;

  const invalidOptionalFields = [
    ...new Set(
      normalized.issues
        .map((issue) => issue.field.split('.', 1)[0])
        .filter((field): field is string => field !== undefined && field !== ''),
    ),
  ];
  if (
    invalidOptionalFields.length === 0 ||
    invalidOptionalFields.some((field) => !RECOVERABLE_OPTIONAL_FIELDS.has(field))
  ) {
    return null;
  }

  const retryCandidate = omitFields(candidate, invalidOptionalFields);
  const retried = normalizePublicProduct(retryCandidate);
  return retried.ok ? retried.value : null;
}

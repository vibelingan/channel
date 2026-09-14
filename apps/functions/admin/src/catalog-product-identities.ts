import { randomUUID } from 'node:crypto';
import { saveCatalogProductWithIdentities } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  normalizeProductSlug,
  normalizeSkuCode,
} from '@vibelingan-channel/shared';

export type CatalogProductWriteErrorCode =
  | 'IDENTITY_CONFLICT'
  | 'INVALID_IDENTITY'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_EXISTS'
  | 'PRODUCT_NOT_FOUND';

export class CatalogProductWriteError extends Error {
  constructor(
    readonly code: CatalogProductWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogProductWriteError';
  }
}

export interface CatalogProductWriteTransition {
  doc: CollectionDoc;
  previous: CollectionDoc | null;
}

function canonicalizeIdentityFields(values: unknown): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new CatalogProductWriteError('INVALID_IDENTITY', 'Product values are invalid.');
  }
  const record = values as Record<string, unknown>;
  const canonical = { ...record };
  if (Object.hasOwn(record, 'slug')) {
    if (
      record.slug === undefined ||
      record.slug === null ||
      (typeof record.slug === 'string' && record.slug.trim() === '')
    ) {
      canonical.slug = typeof record.slug === 'string' ? '' : record.slug;
    } else {
      const slug = normalizeProductSlug(record.slug);
      if (slug === null) {
        throw new CatalogProductWriteError('INVALID_IDENTITY', 'Product slug is invalid.');
      }
      canonical.slug = slug;
    }
  }
  if (Object.hasOwn(record, 'skuCode')) {
    if (
      record.skuCode === undefined ||
      record.skuCode === null ||
      (typeof record.skuCode === 'string' && record.skuCode.trim() === '')
    ) {
      canonical.skuCode = typeof record.skuCode === 'string' ? '' : record.skuCode;
    } else {
      const skuCode = normalizeSkuCode(record.skuCode);
      if (skuCode === null) {
        throw new CatalogProductWriteError('INVALID_IDENTITY', 'Product SKU code is invalid.');
      }
      canonical.skuCode = skuCode;
    }
  }
  return canonical;
}

async function saveCatalogProduct(input: {
  mode: 'create' | 'update';
  productId: string;
  values: unknown;
}): Promise<CatalogProductWriteTransition> {
  const result = await saveCatalogProductWithIdentities({
    mode: input.mode,
    productId: input.productId,
    data: canonicalizeIdentityFields(input.values),
  });
  if (result.result === 'saved') return { doc: result.doc, previous: result.previous };
  if (result.result === 'conflict') {
    throw new CatalogProductWriteError(
      'IDENTITY_CONFLICT',
      `Product ${result.kind} is already in use: ${result.normalizedValue}`,
    );
  }
  if (result.result === 'invalid') {
    throw new CatalogProductWriteError('INVALID_IDENTITY', `Product ${result.kind} is invalid.`);
  }
  if (result.result === 'invalid-product') {
    throw new CatalogProductWriteError(
      'INVALID_PRODUCT',
      result.issues.map((issue) => issue.message).join('; '),
    );
  }
  if (result.result === 'exists') {
    throw new CatalogProductWriteError('PRODUCT_EXISTS', 'Product already exists.');
  }
  throw new CatalogProductWriteError('PRODUCT_NOT_FOUND', 'Product was not found.');
}

export function createCatalogProductRecord(
  values: unknown,
  productId: string = randomUUID(),
): Promise<CatalogProductWriteTransition> {
  return saveCatalogProduct({ mode: 'create', productId, values });
}

export function updateCatalogProductRecord(
  productId: string,
  values: unknown,
): Promise<CatalogProductWriteTransition> {
  return saveCatalogProduct({ mode: 'update', productId, values });
}

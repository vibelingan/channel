import { randomUUID } from 'node:crypto';
import {
  type CatalogProductSaveInput,
  saveCatalogProductWithIdentities,
} from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  canonicalizeCatalogProductIdentities,
} from '@vibelingan-channel/shared';

export type CatalogProductWriteErrorCode =
  | 'IDENTITY_CONFLICT'
  | 'INVALID_IDENTITY'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_EXISTS'
  | 'PRODUCT_STALE'
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
  const canonical = canonicalizeCatalogProductIdentities(values as Record<string, unknown>);
  if (!canonical.ok)
    throw new CatalogProductWriteError(
      'INVALID_IDENTITY',
      canonical.kind === 'slug' ? 'Product slug is invalid.' : 'Product SKU code is invalid.',
    );
  return canonical.values;
}

async function saveCatalogProduct(input: {
  mode: 'create' | 'update';
  productId: string;
  values: unknown;
  requireDetailApproval?: CatalogProductSaveInput['requireDetailApproval'];
  expectedUpdatedAt?: string | null;
  rejectPendingReview?: boolean;
  expectedPrimarySourceKey?: string | null;
}): Promise<CatalogProductWriteTransition> {
  const result = await saveCatalogProductWithIdentities({
    mode: input.mode,
    productId: input.productId,
    data: canonicalizeIdentityFields(input.values),
    ...(input.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: input.expectedUpdatedAt }
      : {}),
    ...(input.rejectPendingReview
      ? { rejectPendingReview: true, expectedPrimarySourceKey: input.expectedPrimarySourceKey }
      : {}),
    ...(input.requireDetailApproval ? { requireDetailApproval: input.requireDetailApproval } : {}),
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
  if (result.result === 'stale') {
    throw new CatalogProductWriteError(
      'PRODUCT_STALE',
      'Product changed since classification. Refresh before publishing.',
    );
  }
  throw new CatalogProductWriteError('PRODUCT_NOT_FOUND', 'Product was not found.');
}

export function createCatalogProductRecord(
  values: unknown,
  productId: string = randomUUID(),
  requireDetailApproval: CatalogProductSaveInput['requireDetailApproval'] = false,
): Promise<CatalogProductWriteTransition> {
  return saveCatalogProduct({ mode: 'create', productId, values, requireDetailApproval });
}

export function updateCatalogProductRecord(
  productId: string,
  values: unknown,
  requireDetailApproval: CatalogProductSaveInput['requireDetailApproval'] = false,
  expectedUpdatedAt?: string | null,
  rejectPendingReview = false,
  expectedPrimarySourceKey: string | null = null,
): Promise<CatalogProductWriteTransition> {
  return saveCatalogProduct({
    mode: 'update',
    productId,
    values,
    requireDetailApproval,
    ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
    ...(rejectPendingReview ? { rejectPendingReview: true, expectedPrimarySourceKey } : {}),
  });
}

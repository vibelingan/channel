/** Ordinary image writes cannot replace the publication protocol's ledger or managed base. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CATALOG_IMAGE_REFERENCE_LEDGER_FIELD } from './catalog-image-reference-store.ts';
type Code =
  | 'IMAGE_REFERENCE_DELETION_REQUIRED'
  | 'IMAGE_REFERENCE_WRITE_CONFLICT'
  | 'IMAGE_REFERENCE_LEDGER_WRITE_FORBIDDEN'
  | 'INVALID_IMAGE_REFERENCE_WRITE';
export class ImageReferenceWriteError extends Error {
  constructor(readonly code: Code) {
    super(
      code === 'IMAGE_REFERENCE_WRITE_CONFLICT'
        ? 'Image reference count belongs to a product operation.'
        : code === 'IMAGE_REFERENCE_DELETION_REQUIRED'
          ? 'Images with managed references require the deletion workflow.'
          : 'Invalid ordinary image reference write.',
    );
    this.name = 'ImageReferenceWriteError';
  }
}
export function isImageReferenceWriteConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'name') === 'ImageReferenceWriteError' &&
    Reflect.get(error, 'code') === 'IMAGE_REFERENCE_WRITE_CONFLICT'
  );
}
export function assertOrdinaryImageReferenceWrite(
  current: CollectionDoc | null,
  patch: Record<string, unknown>,
): void {
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) =>
        key === CATALOG_IMAGE_REFERENCE_LEDGER_FIELD ||
        key.startsWith(`${CATALOG_IMAGE_REFERENCE_LEDGER_FIELD}.`) ||
        key.startsWith(`${CATALOG_IMAGE_REFERENCE_LEDGER_FIELD}[`),
    )
  )
    throw new ImageReferenceWriteError('IMAGE_REFERENCE_LEDGER_WRITE_FORBIDDEN');
  if (
    keys.some(
      (key) =>
        key.startsWith('$') ||
        key.startsWith('publishedRefCount.') ||
        key.startsWith('publishedRefCount['),
    )
  )
    throw new ImageReferenceWriteError('INVALID_IMAGE_REFERENCE_WRITE');
  if (!Object.hasOwn(patch, 'publishedRefCount')) return;
  const count = patch.publishedRefCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw new ImageReferenceWriteError('INVALID_IMAGE_REFERENCE_WRITE');
  if (
    current &&
    Object.hasOwn(current, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD) &&
    (!Object.hasOwn(current, 'publishedRefCount') || current.publishedRefCount !== count)
  )
    throw new ImageReferenceWriteError('IMAGE_REFERENCE_WRITE_CONFLICT');
}

/** Managed references may only be removed by the existing durable deletion workflow. */
export function assertOrdinaryImageReferenceRemoval(image: CollectionDoc): void {
  if (Object.hasOwn(image, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD))
    throw new ImageReferenceWriteError('IMAGE_REFERENCE_DELETION_REQUIRED');
}

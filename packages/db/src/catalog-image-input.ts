import { createHash } from 'node:crypto';
import {
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MIME_TYPES,
  type CollectionDoc,
} from '@vibelingan-channel/shared';

export type StoredCatalogImage = CollectionDoc & {
  storageFileId: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};
/** Refcounts and mutex owners change independently of stored content. */
export function storedCatalogImageInputDigest(image: CollectionDoc): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        image._id,
        image.status,
        image.storageProvider,
        image.storageMode,
        image.storageFileId,
        image.storagePath,
        image.mimeType,
        image.byteSize,
        image.checksumSha256,
      ]),
    )
    .digest('hex');
}

export function isStoredCatalogImageRecord(
  image: CollectionDoc | null,
  imageId: string,
): image is StoredCatalogImage {
  return (
    image !== null &&
    image._id === imageId &&
    image.status === 'active' &&
    (image.storageProvider === 'cloudbase-storage' || image.storageProvider === 'local-disk') &&
    !Object.hasOwn(image, 'data') &&
    (image.storageMode === undefined ||
      image.storageMode ===
        (image.storageProvider === 'local-disk' ? 'local-disk' : 'classic-nosql-storage')) &&
    (image.storagePath === undefined || typeof image.storagePath === 'string') &&
    typeof image.storageFileId === 'string' &&
    image.storageFileId.length > 0 &&
    typeof image.mimeType === 'string' &&
    CATALOG_IMAGE_MIME_TYPES.some((mime) => mime === image.mimeType) &&
    typeof image.byteSize === 'number' &&
    Number.isSafeInteger(image.byteSize) &&
    image.byteSize > 0 &&
    image.byteSize <= CATALOG_IMAGE_MAX_BYTES &&
    typeof image.checksumSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(image.checksumSha256) &&
    (!Object.hasOwn(image, 'publishedRefCount') ||
      (typeof image.publishedRefCount === 'number' &&
        Number.isSafeInteger(image.publishedRefCount) &&
        image.publishedRefCount >= 0))
  );
}

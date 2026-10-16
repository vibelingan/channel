/** Read-only evidence for stored bytes. This does not prove pixel decoding or authorize publication. */
import { createHash } from 'node:crypto';
import { get } from '@vibelingan-channel/db';
import { IMAGE_MUTATION_STALE_MS, readImageMutationState } from '@vibelingan-channel/db/adapter';
import {
  type StoredCatalogImage as StoredImage,
  storedCatalogImageInputDigest,
  isStoredCatalogImageRecord as validRecord,
} from '@vibelingan-channel/db/catalog-image-input';
import { isMediaReadError, mediaStorage } from '@vibelingan-channel/media-storage';
import {
  CATALOG_IMAGE_MAX_BYTES,
  type CollectionDoc,
  signatureMatchesMime,
  sniffMagicBytes,
} from '@vibelingan-channel/shared';

type ImageRead = { body: string; byteSize?: number };
export type StoredCatalogImageByteCheck =
  | {
      status: 'verified';
      kind: 'stored-image-byte-check-v1';
      imageId: string;
      inputDigest: string;
      byteSize: number;
      checksumSha256: string;
    }
  | { status: 'invalid'; reason: 'record' | 'size' | 'checksum' | 'content' }
  | { status: 'retry'; reason: 'busy' | 'unavailable' | 'changed' };

type ByteProof = Extract<StoredCatalogImageByteCheck, { status: 'verified' }>;
type ByteFailure = Extract<StoredCatalogImageByteCheck, { status: 'invalid' | 'retry' }>;
export type StoredImageReadOptions = {
  getImage?: (id: string) => Promise<CollectionDoc | null>;
  readObject?: (fileId: string) => Promise<ImageRead>;
  now?: () => number;
};

export function readStoredCatalogImageBytes(
  imageId: string,
  options: StoredImageReadOptions = {},
): Promise<StoredCatalogImageByteCheck> {
  return inspectStoredCatalogImage(imageId, (proof) => proof, options);
}

/** Inspect validated private bytes before the final current-record and mutex check. */
export async function inspectStoredCatalogImage<T>(
  imageId: string,
  inspect: (proof: ByteProof, bytes: Buffer, mimeType: string) => T | Promise<T>,
  options: StoredImageReadOptions = {},
): Promise<T | ByteFailure> {
  if (typeof imageId !== 'string' || !imageId || imageId.length > 200 || imageId.trim() !== imageId)
    return { status: 'invalid', reason: 'record' };
  const getImage = options.getImage ?? ((id: string) => get('images', id));
  const readObject =
    options.readObject ??
    ((id: string) =>
      mediaStorage().getObjectAsBase64(id, {
        maxBytes: CATALOG_IMAGE_MAX_BYTES,
        timeoutMs: 5000,
      }));
  const now = options.now ?? Date.now;
  let image: CollectionDoc | null;
  try {
    image = await getImage(imageId);
  } catch {
    return { status: 'retry', reason: 'unavailable' };
  }
  if (!validRecord(image, imageId)) return { status: 'invalid', reason: 'record' };
  const initialLock = checkLock(image, now());
  if (initialLock) return initialLock;
  const inputDigest = storedCatalogImageInputDigest(image);
  let result: T | ByteFailure;
  try {
    const checked = checkBytes(image, await readObject(image.storageFileId), inputDigest);
    result =
      'proof' in checked ? await inspect(checked.proof, checked.bytes, image.mimeType) : checked;
  } catch (error) {
    result =
      isMediaReadError(error) && error.reason === 'too-large'
        ? { status: 'invalid', reason: 'size' }
        : { status: 'retry', reason: 'unavailable' };
  }
  let current: CollectionDoc | null;
  try {
    current = await getImage(imageId);
  } catch {
    return { status: 'retry', reason: 'unavailable' };
  }
  if (!current || storedCatalogImageInputDigest(current) !== inputDigest)
    return { status: 'retry', reason: 'changed' };
  if (!validRecord(current, imageId)) return { status: 'invalid', reason: 'record' };
  const currentLock = checkLock(current, now());
  return currentLock ?? result;
}

function checkBytes(
  image: StoredImage,
  object: ImageRead,
  inputDigest: string,
): { proof: ByteProof; bytes: Buffer } | ByteFailure {
  if (
    typeof object?.body !== 'string' ||
    object.body.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(object.body)
  )
    return { status: 'invalid', reason: 'content' };
  // A storage adapter hint cannot prove the size of the actual downloaded bytes.
  if (object.body.length > 4 * Math.ceil(CATALOG_IMAGE_MAX_BYTES / 3))
    return { status: 'invalid', reason: 'size' };
  const bytes = Buffer.from(object.body, 'base64');
  if (bytes.toString('base64') !== object.body) return { status: 'invalid', reason: 'content' };
  if (!bytes.length || bytes.length > CATALOG_IMAGE_MAX_BYTES || bytes.length !== image.byteSize)
    return { status: 'invalid', reason: 'size' };
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  if (checksumSha256 !== image.checksumSha256) return { status: 'invalid', reason: 'checksum' };
  if (!signatureMatchesMime(sniffMagicBytes(bytes), image.mimeType))
    return { status: 'invalid', reason: 'content' };
  return {
    proof: {
      status: 'verified',
      kind: 'stored-image-byte-check-v1',
      imageId: image._id,
      inputDigest,
      byteSize: bytes.length,
      checksumSha256,
    },
    bytes,
  };
}

function checkLock(
  image: CollectionDoc,
  now: number,
): Extract<StoredCatalogImageByteCheck, { status: 'invalid' | 'retry' }> | null {
  if (!Number.isFinite(now)) throw new Error('Invalid image check clock');
  const lock = readImageMutationState(image);
  if (lock.state === 'free') return null;
  return lock.state === 'owned' && now - Date.parse(lock.startedAt) < IMAGE_MUTATION_STALE_MS
    ? { status: 'retry', reason: 'busy' }
    : { status: 'invalid', reason: 'record' };
}

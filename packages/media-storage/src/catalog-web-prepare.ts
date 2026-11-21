import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MIME_TYPES,
  CATALOG_IMAGE_SAFE_RESPONSE_BYTES,
} from '@vibelingan-channel/shared';
import {
  type MediaStorageAdapter,
  type StoredMediaObject,
  isMediaReadError,
  objectStoragePath,
} from './index.ts';
import { decodeCatalogImagePixels } from './pixels.ts';
import { AnimatedCatalogWebImageError, createCatalogWebImage } from './web-image.ts';

export interface PreparedCatalogWebObject {
  storageProvider: StoredMediaObject['storageProvider'];
  storageFileId: string;
  storagePath: string;
  mimeType: 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  checksumSha256: string;
}
interface PrepareInput {
  imageId: string;
  bytes: Uint8Array;
  mimeType: string;
  checksumSha256: string;
  storage: Pick<MediaStorageAdapter, 'putObject' | 'getObjectAsBase64'>;
  checkpoint(value: Readonly<PreparedCatalogWebObject>): Promise<void>;
  existing?: PreparedCatalogWebObject;
  /** Explicit responsive preparation also handles small still originals. */
  width?: 160 | 640 | 1280;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Callers provide the original bytes they already verified. No second source download. */
export async function prepareCatalogWebObject(
  input: PrepareInput,
): Promise<PreparedCatalogWebObject | null> {
  if (
    (input.width !== undefined && ![160, 640, 1280].includes(input.width)) ||
    !input.imageId ||
    input.imageId.length > 200 ||
    !input.bytes.length ||
    input.bytes.length > CATALOG_IMAGE_MAX_BYTES ||
    hash(input.bytes) !== input.checksumSha256 ||
    !CATALOG_IMAGE_MIME_TYPES.some((mime) => mime === input.mimeType)
  )
    throw Error('Catalog web image source bytes or identity differ');
  const logicalId = hash(Buffer.from(input.imageId));
  const existing: PreparedCatalogWebObject | undefined = input.existing
    ? {
        storageProvider: input.existing.storageProvider,
        storageFileId: input.existing.storageFileId,
        storagePath: input.existing.storagePath,
        mimeType: input.existing.mimeType,
        byteSize: input.existing.byteSize,
        width: input.existing.width,
        height: input.existing.height,
        checksumSha256: input.existing.checksumSha256,
      }
    : undefined;
  const path = (sha: string) =>
    objectStoragePath({
      namespace: 'catalog-web',
      logicalId,
      fileName: `${input.checksumSha256}-${sha}.webp`,
    });
  const verify = async (value: PreparedCatalogWebObject) => {
    if (value.storagePath !== path(value.checksumSha256))
      throw Error('Catalog web target path differs');
    const read = await input.storage.getObjectAsBase64(value.storageFileId, {
      maxBytes: value.byteSize,
      timeoutMs: 15_000,
    });
    const bytes = Buffer.from(read.body, 'base64');
    if (
      bytes.toString('base64') !== read.body ||
      bytes.length !== value.byteSize ||
      hash(bytes) !== value.checksumSha256
    )
      throw Error('Catalog web read-back bytes or digest differ');
    const pixels = await decodeCatalogImagePixels(bytes, value.mimeType);
    if (
      pixels.status !== 'decoded' ||
      pixels.pages !== 1 ||
      pixels.width !== value.width ||
      pixels.height !== value.height
    )
      throw Error('Catalog web read-back pixels differ');
  };
  if (existing) {
    if (existing.width > (input.width ?? 1280))
      throw Error('Catalog web target exceeds its requested width');
    try {
      await verify(existing);
      return existing;
    } catch (error) {
      if (!isMediaReadError(error) || error.reason !== 'unavailable') throw error;
      // An unknown prior PUT may have left no bytes. Only the exact same immutable
      // content may be retried below; a corrupt readable object is never overwritten.
    }
  } else if (input.width === undefined && input.bytes.length <= 100 * 1024) return null;
  let generated: Awaited<ReturnType<typeof createCatalogWebImage>>;
  try {
    generated = await createCatalogWebImage(input.bytes, input.mimeType, input.width ?? 1280);
  } catch (error) {
    if (
      error instanceof AnimatedCatalogWebImageError &&
      input.bytes.length <= CATALOG_IMAGE_SAFE_RESPONSE_BYTES
    )
      return null;
    throw error;
  }
  const object = {
    namespace: 'catalog-web' as const,
    logicalId,
    fileName: `${input.checksumSha256}-${generated.checksumSha256}.webp`,
    mimeType: generated.mimeType,
    content: generated.bytes,
  };
  const describe = (target: StoredMediaObject): PreparedCatalogWebObject => {
    if (target.storagePath !== path(generated.checksumSha256))
      throw Error('Catalog web upload path differs');
    return {
      storageProvider: target.storageProvider,
      storageFileId: target.storageFileId,
      storagePath: target.storagePath,
      mimeType: generated.mimeType,
      byteSize: generated.byteSize,
      width: generated.width,
      height: generated.height,
      checksumSha256: generated.checksumSha256,
    };
  };
  let planned: PreparedCatalogWebObject | undefined;
  const target = await input.storage.putObject(object, {
    beforeWrite: async (target) => {
      if (planned) throw Error('Only one catalog web target may be written');
      const candidate = describe(target);
      if (existing && !isDeepStrictEqual(candidate, existing))
        throw Error('A retry must preserve the exact planned catalog web bytes');
      await input.checkpoint(Object.freeze({ ...candidate }));
      planned = candidate;
    },
  });
  const ready = describe(target);
  if (!planned || !isDeepStrictEqual(planned, ready))
    throw Error('Catalog web upload was not durably checkpointed');
  await verify(ready);
  return ready;
}

export interface PreparedCatalogWebVariants {
  default: PreparedCatalogWebObject;
  variants: {
    '160'?: PreparedCatalogWebObject | undefined;
    '640'?: PreparedCatalogWebObject | undefined;
  };
}

/** Every checkpoint includes all earlier targets, including a PUT with an unknown outcome. */
export async function prepareCatalogWebVariants(
  input: Omit<PrepareInput, 'existing' | 'checkpoint' | 'width'> & {
    existing?: PreparedCatalogWebVariants;
    /** Reviewed preparation may specify the default width for an already small original. */
    defaultWidth?: 1280;
    checkpoint(value: Readonly<PreparedCatalogWebVariants>): Promise<void>;
  },
): Promise<PreparedCatalogWebVariants | null> {
  let planned = input.existing ? structuredClone(input.existing) : undefined;
  const { defaultWidth, existing: _existing, checkpoint: _checkpoint, ...source } = input;
  const defaultObject = await prepareCatalogWebObject({
    ...source,
    ...(defaultWidth === undefined ? {} : { width: defaultWidth }),
    ...(planned ? { existing: planned.default } : {}),
    checkpoint: async (value) => {
      const next = { default: value, variants: planned?.variants ?? {} };
      await input.checkpoint(structuredClone(next));
      planned = next;
    },
  });
  if (!defaultObject) {
    if (planned) throw Error('Existing web targets cannot be abandoned');
    return null;
  }
  planned ??= { default: defaultObject, variants: {} };
  for (const width of [160, 640] as const) {
    const key = String(width) as '160' | '640';
    if (defaultObject.width <= width) {
      if (planned.variants[key]) throw Error('Unexpected duplicate catalog web target');
      continue;
    }
    const existing = planned.variants[key];
    const object = await prepareCatalogWebObject({
      ...source,
      width,
      ...(existing ? { existing } : {}),
      checkpoint: async (value) => {
        if (!planned) throw Error('Catalog web default must be checkpointed first');
        const next = { default: defaultObject, variants: { ...planned.variants, [key]: value } };
        await input.checkpoint(structuredClone(next));
        planned = next;
      },
    });
    if (!object || object.width !== width) throw Error('Catalog responsive pixels differ');
    // An existing target is verified without another write or database checkpoint.
    planned = { default: defaultObject, variants: { ...planned.variants, [key]: object } };
  }
  return planned;
}

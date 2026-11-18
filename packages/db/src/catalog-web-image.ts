import { createHash } from 'node:crypto';
import { catalogWebObjectPath } from '@vibelingan-channel/shared/catalog-media-protection';
export function catalogWebImagePath(imageId: string, sourceSha: string, outputSha: string): string {
  return catalogWebObjectPath(
    createHash('sha256').update(imageId).digest('hex'),
    sourceSha,
    outputSha,
  );
}
import { isDeepStrictEqual } from 'node:util';
import { CATALOG_IMAGE_SAFE_RESPONSE_BYTES, type CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from './catalog-image-input.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogWebImageSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceDigest: hash,
    storageProvider: z.enum(['cloudbase-storage', 'local-disk']),
    storageFileId: z.string().min(1).max(2048),
    storagePath: z.string().min(1).max(2048),
    mimeType: z.literal('image/webp'),
    byteSize: z.number().int().min(1).max(3_000_000),
    width: z.number().int().min(1).max(1280),
    height: z.number().int().min(1).max(16383),
    checksumSha256: hash,
  })
  .strict();
export type CatalogWebImage = z.infer<typeof CatalogWebImageSchema>;
export const CatalogWebVariantsSchema = z
  .object({
    '160': CatalogWebImageSchema.optional(),
    '640': CatalogWebImageSchema.optional(),
  })
  .strict();
export type CatalogWebVariants = z.infer<typeof CatalogWebVariantsSchema>;

export function bindCatalogWebVariants(
  source: CollectionDoc,
  objects: {
    '160'?: Omit<CatalogWebImage, 'schemaVersion' | 'sourceDigest'> | undefined;
    '640'?: Omit<CatalogWebImage, 'schemaVersion' | 'sourceDigest'> | undefined;
  },
): CatalogWebVariants {
  return CatalogWebVariantsSchema.parse(
    Object.fromEntries(
      Object.entries(objects).flatMap(([key, value]) =>
        value ? [[key, bindCatalogWebImage(source, value)]] : [],
      ),
    ),
  );
}

/** A preparation may only append targets. A retry must preserve every earlier identity. */
export function extendsCatalogWebVariants(previous: unknown, next: unknown): boolean {
  const before = CatalogWebVariantsSchema.safeParse(previous === undefined ? {} : previous);
  const after = CatalogWebVariantsSchema.safeParse(next === undefined ? {} : next);
  return (
    before.success &&
    after.success &&
    Object.entries(before.data).every(([key, value]) =>
      isDeepStrictEqual(value, Reflect.get(after.data, key)),
    )
  );
}

/** Bind a verified object to exactly the original that will become active. */
export function bindCatalogWebImage(
  source: CollectionDoc,
  object: Omit<CatalogWebImage, 'schemaVersion' | 'sourceDigest'>,
): CatalogWebImage {
  const candidate = CatalogWebImageSchema.parse({
    ...object,
    schemaVersion: 1,
    sourceDigest: storedCatalogImageInputDigest(source),
  });
  if (!readCatalogWebImage({ ...source, catalogWebImage: candidate }))
    throw Error('Catalog web object does not bind the active original');
  return candidate;
}

export function readCatalogWebImage(image: CollectionDoc): CatalogWebImage | null {
  if (!isStoredCatalogImageRecord(image, image._id)) return null;
  const parsed = CatalogWebImageSchema.safeParse(image.catalogWebImage);
  if (!parsed.success) return null;
  const web = parsed.data;
  const expectedPath = catalogWebImagePath(image._id, image.checksumSha256, web.checksumSha256);
  const sourceBucket = /^cloud:\/\/([^/]+)\//.exec(image.storageFileId)?.[1];
  if (image.storageProvider === 'cloudbase-storage' && !sourceBucket) return null;
  const expectedFile =
    image.storageProvider === 'cloudbase-storage' && sourceBucket
      ? `cloud://${sourceBucket}/${expectedPath}`
      : `local-disk:${expectedPath}`;
  return web.sourceDigest === storedCatalogImageInputDigest(image) &&
    web.storageProvider === image.storageProvider &&
    web.storagePath === expectedPath &&
    web.storageFileId === expectedFile
    ? web
    : null;
}

/** Partial maps are useful only for resumable preparation/deletion, never readiness. */
export function readCatalogWebVariants(image: CollectionDoc): CatalogWebVariants | null {
  const base = readCatalogWebImage(image);
  const parsed = CatalogWebVariantsSchema.safeParse(image.catalogWebVariants);
  if (!base || !parsed.success) return null;
  for (const width of [160, 640] as const) {
    const value = parsed.data[width];
    if (!value) continue;
    if (
      base.width <= width ||
      value.width !== width ||
      !readCatalogWebImage({ ...image, catalogWebImage: value }) ||
      Math.abs(value.height - (base.height * value.width) / base.width) > 1
    )
      return null;
  }
  return parsed.data;
}

export function readCatalogWebImageAtWidth(image: CollectionDoc, width: 160 | 640 | 1280) {
  const base = readCatalogWebImage(image);
  if (!base) return null;
  if (width === 1280) return base;
  if (Object.hasOwn(image, 'catalogWebVariants') && !readCatalogWebVariants(image)) return null;
  return base.width <= width ? base : (readCatalogWebVariants(image)?.[width] ?? null);
}

export function hasCompleteCatalogWebVariants(image: CollectionDoc): boolean {
  return (
    readCatalogWebVariants(image) !== null &&
    [160, 640, 1280].every((width) => readCatalogWebImageAtWidth(image, width as 160 | 640 | 1280))
  );
}

/** The original is kept; only its ability to cross the existing HTTP boundary is constrained. */
export function hasSafeCatalogImageDelivery(image: CollectionDoc): boolean {
  return (
    isStoredCatalogImageRecord(image, image._id) &&
    (image.byteSize <= CATALOG_IMAGE_SAFE_RESPONSE_BYTES || readCatalogWebImage(image) !== null)
  );
}

/** A verified physical move may rebind the same bytes, never retarget a different image. */
export function retargetCatalogWebImage(
  previous: CollectionDoc,
  next: CollectionDoc,
): CollectionDoc {
  if (Object.hasOwn(previous, 'catalogWebVariants') && !readCatalogWebVariants(previous))
    throw Error('A moved image must preserve every responsive target');
  if (!Object.hasOwn(previous, 'catalogWebImage')) return next;
  const web = readCatalogWebImage(previous);
  if (
    !web ||
    ['_id', 'mimeType', 'byteSize', 'checksumSha256'].some(
      (key) => !isDeepStrictEqual(previous[key], next[key]),
    )
  )
    throw Error('A moved image must preserve its verified web delivery');
  const candidate = { ...web, sourceDigest: storedCatalogImageInputDigest(next) };
  let rebound: CollectionDoc = { ...next, catalogWebImage: candidate };
  if (Object.hasOwn(previous, 'catalogWebVariants')) {
    const variants = readCatalogWebVariants(previous);
    if (!variants) throw Error('A moved image must preserve every responsive target');
    rebound = {
      ...rebound,
      catalogWebVariants: Object.fromEntries(
        Object.entries(variants).map(([key, value]) => [
          key,
          { ...value, sourceDigest: storedCatalogImageInputDigest(next) },
        ]),
      ),
    };
    if (!readCatalogWebVariants(rebound))
      throw Error('The moved source cannot use its responsive targets');
  }
  if (!readCatalogWebImage(rebound))
    throw Error('The moved source cannot use the existing web object');
  return rebound;
}
/** Caller owns the database transaction; no storage or decoder calls run inside it. */
export async function registerCatalogWebImage(
  tx: CatalogApprovalTransaction,
  imageId: string,
  input: unknown,
): Promise<'registered' | 'unchanged'> {
  const current = await tx.get('images', imageId);
  if (!current || !readCatalogWebImage({ ...current, catalogWebImage: input }))
    throw Error('Catalog web image source changed or delivery metadata is invalid');
  if (isDeepStrictEqual(current.catalogWebImage, input)) return 'unchanged';
  if (readCatalogWebImage(current)) throw Error('Catalog web image changed concurrently');
  if (
    current.catalogWebImage &&
    Reflect.get(Object(current.catalogWebImage), 'schemaVersion') !== 1
  )
    throw Error('Unknown catalog web image version; preserve it');
  await tx.set('images', { ...current, catalogWebImage: CatalogWebImageSchema.parse(input) });
  return 'registered';
}

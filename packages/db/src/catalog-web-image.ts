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
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from './catalog-image-input.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
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
export type CatalogWebImage = z.infer<typeof schema>;

export function readCatalogWebImage(image: CollectionDoc): CatalogWebImage | null {
  if (!isStoredCatalogImageRecord(image, image._id)) return null;
  const parsed = schema.safeParse(image.catalogWebImage);
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
  await tx.set('images', { ...current, catalogWebImage: schema.parse(input) });
  return 'registered';
}

/** Add ready sizes to an existing image; storage calls run outside the caller's transaction. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from './catalog-image-input.ts';
import {
  CatalogWebImageSchema,
  CatalogWebVariantsSchema,
  extendsCatalogWebVariants,
  hasCompleteCatalogWebVariants,
  readCatalogWebImage,
  readCatalogWebVariants,
} from './catalog-web-image.ts';
import { imageUploadInputDigest, readImageUploadWebPreparation } from './image-upload.ts';

const commandSchema = z
  .object({
    action: z.enum(['checkpoint', 'complete']),
    imageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    owner: z.string().min(1).max(200),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    catalogWebImage: CatalogWebImageSchema,
    catalogWebVariants: CatalogWebVariantsSchema,
  })
  .strict();
export type CatalogWebBackfillCommand = z.infer<typeof commandSchema>;

/** Reuses the upload preparation journal so interrupted files remain discoverable by cleanup. */
export async function runCatalogWebBackfill(
  tx: CatalogApprovalTransaction,
  input: CatalogWebBackfillCommand,
): Promise<'checkpointed' | 'ready' | 'conflict'> {
  const command = commandSchema.parse(input);
  const image = await tx.get('images', command.imageId);
  if (!isStoredCatalogImageRecord(image, command.imageId)) return 'conflict';
  const lock = readImageMutationState(image);
  const base = readCatalogWebImage(image);
  if (
    lock.state !== 'owned' ||
    lock.owner !== command.owner ||
    storedCatalogImageInputDigest(image) !== command.sourceDigest ||
    !base ||
    !isDeepStrictEqual(base, command.catalogWebImage) ||
    (Object.hasOwn(image, 'catalogWebVariants') && !readCatalogWebVariants(image)) ||
    !extendsCatalogWebVariants(image.catalogWebVariants, command.catalogWebVariants)
  )
    return 'conflict';

  const candidate = { ...image, catalogWebVariants: command.catalogWebVariants };
  if (!readCatalogWebVariants(candidate)) return 'conflict';
  const saved = readImageUploadWebPreparation(image);
  if (
    Object.hasOwn(image, 'imageWebPreparation') &&
    (!saved ||
      !isDeepStrictEqual(saved.catalogWebImage, base) ||
      saved.byteSize !== image.byteSize ||
      saved.checksumSha256 !== image.checksumSha256 ||
      !extendsCatalogWebVariants(saved.catalogWebVariants, command.catalogWebVariants))
  )
    return 'conflict';

  if (command.action === 'checkpoint') {
    await tx.set('images', {
      ...image,
      imageWebPreparation: {
        schemaVersion: 'catalog-upload-web-v1',
        inputDigest: imageUploadInputDigest(image),
        byteSize: image.byteSize,
        checksumSha256: image.checksumSha256,
        catalogWebImage: base,
        catalogWebVariants: command.catalogWebVariants,
      },
    });
    return 'checkpointed';
  }

  if (!hasCompleteCatalogWebVariants(candidate)) return 'conflict';
  if (!saved)
    return isDeepStrictEqual(image.catalogWebVariants, command.catalogWebVariants)
      ? 'ready'
      : 'conflict';
  if (!isDeepStrictEqual(saved.catalogWebVariants, command.catalogWebVariants)) return 'conflict';
  const { imageWebPreparation: _preparation, ...current } = image;
  await tx.set('images', { ...current, catalogWebVariants: command.catalogWebVariants });
  return 'ready';
}

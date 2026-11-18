/** Private byte verification; all state changes recheck the same image mutex in storage. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ImageUploadCommand,
  acquireImageMutation,
  canReverifyLegacyImageUpload,
  get,
  hasImageUploadCompletion,
  imageUploadInputDigest,
  manageImageUpload,
  readImageMutationState,
  readImageUploadWebPreparation,
  releaseImageMutation,
} from '@vibelingan-channel/db';
import {
  type CatalogWebImage,
  type CatalogWebVariants,
  bindCatalogWebImage,
  bindCatalogWebVariants,
  hasSafeCatalogImageDelivery,
  readCatalogWebImage,
} from '@vibelingan-channel/db/catalog-web-image';
import { isMediaReadError, mediaStorage } from '@vibelingan-channel/media-storage';
import { prepareCatalogWebVariants } from '@vibelingan-channel/media-storage/catalog-web-prepare';
import { AnimatedCatalogWebImageError } from '@vibelingan-channel/media-storage/web-image';
import {
  CATALOG_IMAGE_MAX_BYTES,
  type CollectionDoc,
  err,
  ok,
  signatureMatchesMime,
  sniffMagicBytes,
} from '@vibelingan-channel/shared';
function completed(image: CollectionDoc) {
  if (!hasSafeCatalogImageDelivery(image))
    return err('CONFLICT', 'This image needs a verified web version before publication.');
  return ok({ imageId: image._id, status: 'active' as const, byteSize: image.byteSize, image });
}
export async function finalizeCatalogImageUpload(imageId: string, actorId: string) {
  const initial = await get('images', imageId);
  if (!initial) return err('NOT_FOUND', 'Upload intent not found.');
  if (initial._id !== imageId) return err('CONFLICT', 'Upload identity changed. Reload and retry.');
  if (initial.uploadedByUserId !== actorId)
    return err('FORBIDDEN', 'Only the uploader can complete this upload.');
  if (hasImageUploadCompletion(initial)) return completed(initial);
  if (initial.status !== 'pending' && !canReverifyLegacyImageUpload(initial))
    return err('CONFLICT', 'This upload cannot be finalized. Upload the file again.');
  const owner = randomUUID();
  let locked = false;
  try {
    try {
      locked =
        (await acquireImageMutation(imageId, owner, new Date().toISOString())) === 'acquired';
    } catch {
      const current = await get('images', imageId);
      const lock = current ? readImageMutationState(current) : null;
      locked = current?._id === imageId && lock?.state === 'owned' && lock.owner === owner;
    }
    if (!locked)
      return err('BUSY', 'This upload is being completed or cleaned up. Try again shortly.');
    const image = await get('images', imageId);
    if (!image) return err('NOT_FOUND', 'Upload intent not found.');
    if (image._id !== imageId || image.uploadedByUserId !== actorId)
      return err('CONFLICT', 'Upload identity changed. Reload and retry.');
    if (hasImageUploadCompletion(image)) return completed(image);
    if (
      (image.status !== 'pending' && !canReverifyLegacyImageUpload(image)) ||
      Object.hasOwn(image, 'sourceMediaImport') ||
      typeof image.storageFileId !== 'string' ||
      !image.storageFileId ||
      typeof image.uploadIntentId !== 'string' ||
      !image.uploadIntentId
    )
      return err('CONFLICT', 'This upload cannot be finalized. Upload the file again.');
    const legacy = canReverifyLegacyImageUpload(image);
    const base = {
      imageId,
      uploadedByUserId: actorId,
      owner,
      inputDigest: imageUploadInputDigest(image),
      now: new Date().toISOString(),
    };
    const persist = (command: ImageUploadCommand) =>
      manageImageUpload(command).catch(() => manageImageUpload(command));
    const reject = async (reason: 'size' | 'checksum' | 'content', message: string) => {
      if (legacy)
        return err(
          'VALIDATION_ERROR',
          'Stored upload could not be verified. Upload a replacement image.',
        );
      const result = await persist({ ...base, action: 'reject', reason });
      if (result.status === 'forbidden')
        return err('FORBIDDEN', 'You no longer have permission to complete this upload.');
      if (result.status !== 'rejected')
        return err('CONFLICT', 'Upload changed while being verified. Reload and retry.');
      // Keep the exact failed target for resumable expiry cleanup, never a blind delete.
      return err('VALIDATION_ERROR', `${message} Upload the file again.`);
    };
    let object: { body: string; byteSize?: number };
    try {
      object = await mediaStorage().getObjectAsBase64(image.storageFileId, {
        maxBytes: CATALOG_IMAGE_MAX_BYTES,
        timeoutMs: 5000,
      });
    } catch (error) {
      if (isMediaReadError(error) && error.reason === 'too-large')
        return await reject('size', 'Uploaded object exceeds the allowed size.');
      return err(
        'NOT_FOUND',
        'The uploaded file is not readable yet. Wait a moment, then retry the upload.',
      );
    }
    if (
      typeof object.body !== 'string' ||
      object.body.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(object.body)
    )
      return await reject('content', 'Uploaded bytes are not valid image data.');
    const bytes = Buffer.from(object.body, 'base64');
    const byteSize = bytes.byteLength;
    if (!byteSize || byteSize > CATALOG_IMAGE_MAX_BYTES)
      return await reject('size', 'Uploaded object exceeds the allowed size or is empty.');
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    if (typeof image.checksumSha256 === 'string' && image.checksumSha256 !== checksumSha256)
      return await reject('checksum', 'Uploaded bytes do not match the declared checksum.');
    if (
      !signatureMatchesMime(
        sniffMagicBytes(bytes),
        typeof image.mimeType === 'string' ? image.mimeType : '',
      )
    )
      return await reject('content', 'Uploaded bytes are not a valid image of the declared type.');
    let webImage: CatalogWebImage | undefined;
    let webVariants: CatalogWebVariants | undefined;
    if (!readCatalogWebImage(image)) {
      const planned = readImageUploadWebPreparation(image);
      if (
        Object.hasOwn(image, 'imageWebPreparation') &&
        (!planned || planned.byteSize !== byteSize || planned.checksumSha256 !== checksumSha256)
      )
        return err('CONFLICT', 'This image preparation changed. Reload before retrying.');
      const activeSource = { ...image, status: 'active', byteSize, checksumSha256 };
      let checkpointFailure: 'forbidden' | 'conflict' | undefined;
      try {
        const save = async (candidate: CatalogWebImage, variants: CatalogWebVariants) => {
          const saved = await persist({
            ...base,
            action: 'checkpoint-web',
            byteSize,
            checksumSha256,
            catalogWebImage: candidate,
            catalogWebVariants: variants,
            now: new Date().toISOString(),
          });
          if (saved.status !== 'checkpointed') {
            checkpointFailure = saved.status === 'forbidden' ? 'forbidden' : 'conflict';
            throw Error('Catalog web checkpoint was not authorized');
          }
        };
        let lastVariants = planned?.catalogWebVariants;
        const object = await prepareCatalogWebVariants({
          imageId,
          bytes,
          mimeType: String(image.mimeType),
          checksumSha256,
          storage: mediaStorage(),
          ...(planned
            ? {
                existing: {
                  default: planned.catalogWebImage,
                  variants: planned.catalogWebVariants ?? {},
                },
              }
            : {}),
          checkpoint: async (value) => {
            const variants = bindCatalogWebVariants(activeSource, value.variants);
            await save(bindCatalogWebImage(activeSource, value.default), variants);
            lastVariants = variants;
          },
        });
        if (object) {
          webImage = bindCatalogWebImage(activeSource, object.default);
          webVariants = bindCatalogWebVariants(activeSource, object.variants);
          if (!isDeepStrictEqual(lastVariants, webVariants)) await save(webImage, webVariants);
        }
      } catch (error) {
        if (checkpointFailure === 'forbidden')
          return err('FORBIDDEN', 'You no longer have permission to complete this upload.');
        if (checkpointFailure)
          return err('CONFLICT', 'Upload ownership changed. Reload before retrying.');
        if (error instanceof AnimatedCatalogWebImageError)
          return err(
            'VALIDATION_ERROR',
            'This animated image is too large for web delivery. Keep all frames and upload a smaller file.',
          );
        return err(
          'BUSY',
          'The web image could not be verified yet. The original is retained; retry or upload a replacement.',
        );
      }
    }
    const result = await persist({
      ...base,
      action: 'activate',
      byteSize,
      checksumSha256,
      ...(webImage ? { catalogWebImage: webImage } : {}),
      ...(webVariants !== undefined ? { catalogWebVariants: webVariants } : {}),
      now: new Date().toISOString(),
    });
    if (result.status === 'forbidden')
      return err('FORBIDDEN', 'You no longer have permission to complete this upload.');
    if (result.status !== 'active')
      return err('CONFLICT', 'Upload changed while being verified. Reload and retry.');
    const activated = await get('images', imageId);
    if (
      !activated ||
      activated._id !== imageId ||
      activated.uploadedByUserId !== actorId ||
      !hasImageUploadCompletion(activated) ||
      activated.byteSize !== byteSize ||
      activated.checksumSha256 !== checksumSha256
    )
      return err('BUSY', 'Upload completion needs to be checked. Try again shortly.');
    if (webImage && !isDeepStrictEqual(readCatalogWebImage(activated), webImage))
      return err('BUSY', 'Web image activation needs to be checked. Try again shortly.');
    return completed(activated);
  } finally {
    if (locked)
      await releaseImageMutation(imageId, owner)
        .catch(() => releaseImageMutation(imageId, owner))
        .catch(() => {});
  }
}

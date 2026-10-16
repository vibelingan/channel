/** Finalize a verified upload under the existing image mutex, without storage calls. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CATALOG_IMAGE_MAX_BYTES,
  type CollectionDoc,
  canEditCollection,
  toRole,
} from '@vibelingan-channel/shared';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import type { ImageDeletionStore } from './image-deletion.ts';
const token = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({
  imageId: token,
  uploadedByUserId: token,
  owner: token,
  inputDigest: digest,
  now: z
    .string()
    .datetime()
    .refine(
      (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    ),
});
export const ImageUploadCommandSchema = z.discriminatedUnion('action', [
  base
    .extend({
      action: z.literal('activate'),
      byteSize: z.number().int().min(1).max(CATALOG_IMAGE_MAX_BYTES),
      checksumSha256: digest,
    })
    .strict(),
  base
    .extend({ action: z.literal('reject'), reason: z.enum(['size', 'checksum', 'content']) })
    .strict(),
]);
export type ImageUploadCommand = z.infer<typeof ImageUploadCommandSchema>;
export type ImageUploadResult = {
  status: 'active' | 'rejected' | 'missing' | 'forbidden' | 'conflict' | 'corrupt';
};
const completion = z
  .object({
    schemaVersion: z.literal('image-upload-completion-v1'),
    inputDigest: digest,
    outputDigest: digest,
  })
  .strict();
const rejection = z
  .object({
    schemaVersion: z.literal('image-upload-rejection-v1'),
    inputDigest: digest,
    reason: z.enum(['size', 'checksum', 'content']),
  })
  .strict();
/** Excludes refcounts and temporary mutex fields, which do not change upload bytes. */
export function imageUploadInputDigest(image: CollectionDoc): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        image._id,
        image.uploadedByUserId,
        image.uploadIntentId,
        image.purpose,
        image.storageProvider,
        image.storageMode,
        image.storagePath,
        image.storageFileId,
        image.mimeType,
        image.byteSize,
        image.checksumSha256,
      ]),
    )
    .digest('hex');
}
export function hasImageUploadCompletion(image: CollectionDoc): boolean {
  const parsed = completion.safeParse(image.imageUploadCompletion);
  return (
    image.status === 'active' &&
    parsed.success &&
    parsed.data.outputDigest === imageUploadInputDigest(image)
  );
}
/** A verified physical move preserves completion only for the same upload identity and bytes. */
export function retargetImageUploadCompletion(
  previous: CollectionDoc,
  next: CollectionDoc,
): CollectionDoc {
  const identity = [
    '_id',
    'uploadedByUserId',
    'uploadIntentId',
    'purpose',
    'mimeType',
    'byteSize',
    'checksumSha256',
  ];
  if (
    !hasImageUploadCompletion(previous) ||
    next.status !== 'active' ||
    identity.some((key) => !isDeepStrictEqual(previous[key], next[key]))
  )
    return next;
  const saved = completion.parse(previous.imageUploadCompletion);
  return {
    ...next,
    imageUploadCompletion: { ...saved, outputDigest: imageUploadInputDigest(next) },
  };
}

/** An old direct upload needs one physical recheck; unknown new receipts never use this path. */
export function canReverifyLegacyImageUpload(image: CollectionDoc): boolean {
  return (
    image.status === 'active' &&
    !Object.hasOwn(image, 'imageUploadCompletion') &&
    !Object.hasOwn(image, 'sourceMediaImport') &&
    typeof image.uploadIntentId === 'string' &&
    image.uploadIntentId.length > 0 &&
    typeof image.byteSize === 'number' &&
    Number.isSafeInteger(image.byteSize) &&
    image.byteSize > 0 &&
    image.byteSize <= CATALOG_IMAGE_MAX_BYTES &&
    typeof image.checksumSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(image.checksumSha256)
  );
}
export async function runImageUpload(
  store: ImageDeletionStore,
  input: ImageUploadCommand,
): Promise<ImageUploadResult> {
  const command = ImageUploadCommandSchema.parse(input);
  const actor = await store.get('users', command.uploadedByUserId);
  if (
    actor?._id !== command.uploadedByUserId ||
    actor.status === 'suspended' ||
    !canEditCollection(toRole(actor.role), 'images')
  )
    return { status: 'forbidden' };
  const image = await store.get('images', command.imageId);
  if (!image) return { status: 'missing' };
  if (image._id !== command.imageId) return { status: 'corrupt' };
  if (image.uploadedByUserId !== command.uploadedByUserId) return { status: 'forbidden' };
  if (command.action === 'activate' && hasImageUploadCompletion(image)) {
    const saved = completion.parse(image.imageUploadCompletion);
    return {
      status:
        saved.inputDigest === command.inputDigest &&
        image.byteSize === command.byteSize &&
        image.checksumSha256 === command.checksumSha256
          ? 'active'
          : 'conflict',
    };
  }
  if (command.action === 'reject' && image.status === 'failed') {
    const saved = rejection.safeParse(image.imageUploadRejection);
    if (
      saved.success &&
      saved.data.inputDigest === command.inputDigest &&
      saved.data.reason === command.reason &&
      imageUploadInputDigest(image) === command.inputDigest
    )
      return { status: 'rejected' };
  }
  const legacy = canReverifyLegacyImageUpload(image);
  if (
    legacy &&
    (command.action !== 'activate' ||
      image.byteSize !== command.byteSize ||
      image.checksumSha256 !== command.checksumSha256)
  )
    return { status: 'conflict' };
  const counter = image.publishedRefCount ?? 0;
  const lock = readImageMutationState(image);
  if (
    (image.status !== 'pending' && !legacy) ||
    Object.hasOwn(image, 'sourceMediaImport') ||
    typeof image.uploadIntentId !== 'string' ||
    !image.uploadIntentId ||
    typeof image.storageFileId !== 'string' ||
    !image.storageFileId ||
    (image.storageProvider !== 'local-disk' && image.storageProvider !== 'cloudbase-storage') ||
    (legacy
      ? typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0
      : counter !== 0) ||
    lock.state !== 'owned' ||
    lock.owner !== command.owner ||
    imageUploadInputDigest(image) !== command.inputDigest
  )
    return { status: 'conflict' };
  if (command.action === 'reject') {
    await store.set('images', {
      ...image,
      status: 'failed',
      imageUploadRejection: {
        schemaVersion: 'image-upload-rejection-v1',
        inputDigest: command.inputDigest,
        reason: command.reason,
      },
      updatedAt: command.now,
    });
    return { status: 'rejected' };
  }
  const active = {
    ...image,
    status: 'active',
    byteSize: command.byteSize,
    checksumSha256: command.checksumSha256,
    updatedAt: command.now,
  };
  await store.set('images', {
    ...active,
    imageUploadCompletion: {
      schemaVersion: 'image-upload-completion-v1',
      inputDigest: command.inputDigest,
      outputDigest: imageUploadInputDigest(active),
    },
  });
  return { status: 'active' };
}

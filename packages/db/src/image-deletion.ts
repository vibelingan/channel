/** Durable quarantine before byte deletion; storage calls stay outside transactions. */
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';

const token = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const time = z
  .string()
  .datetime()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const base = z.object({ imageId: token, uploadedByUserId: token });
export const ImageDeletionCommandSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('begin'), owner: token, startedAt: time }).strict(),
  z
    .object({
      action: z.literal('begin-orphan'),
      imageId: token,
      owner: token,
      startedAt: time,
      cutoff: time,
    })
    .strict(),
  base
    .extend({ action: z.literal('finish'), operationId: token, uploadedByUserId: token.optional() })
    .strict(),
]);
export type ImageDeletionCommand = z.infer<typeof ImageDeletionCommandSchema>;
const intentFields = z.object({
  operationId: token,
  startedAt: time,
  storageProvider: z.string().max(64),
  storageFileIds: z.array(z.string().min(1).max(8192)).max(2),
});
export const ImageDeletionIntentSchema = z.discriminatedUnion('schemaVersion', [
  intentFields
    .extend({ schemaVersion: z.literal('image-deletion-v1'), uploadedByUserId: token })
    .strict(),
  intentFields
    .extend({
      schemaVersion: z.literal('image-deletion-ownerless-v1'),
      uploadedByUserId: z.never().optional(),
    })
    .strict(),
]);
export type ImageDeletionIntent = z.infer<typeof ImageDeletionIntentSchema>;
export interface ImageDeletionStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: string, row: CollectionDoc): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}
export type ImageDeletionResult =
  | { status: 'ready'; intent: ImageDeletionIntent }
  | { status: 'missing' | 'removed' | 'forbidden' | 'conflict' | 'corrupt' };

function targets(image: CollectionDoc) {
  const values = [image.storageFileId, image.migrationStorageFileId];
  if (values.some((value) => value != null && typeof value !== 'string')) return null;
  const storageFileIds = [
    ...new Set(
      values.flatMap((value) => (typeof value === 'string' && value.length > 0 ? [value] : [])),
    ),
  ];
  const storageProvider = typeof image.storageProvider === 'string' ? image.storageProvider : '';
  if (
    storageFileIds.length &&
    storageProvider !== 'cloudbase-storage' &&
    storageProvider !== 'local-disk'
  )
    return null;
  if (storageFileIds.some((value) => value.length > 8192)) return null;
  return { storageProvider, storageFileIds };
}

/** Only a persisted terminal row with unchanged storage identity may be resumed. */
export function readImageDeletionIntent(image: CollectionDoc): ImageDeletionIntent | null {
  if (image.status !== 'deleted') return null;
  const parsed = ImageDeletionIntentSchema.safeParse(image.imageDeletion);
  if (!parsed.success || parsed.data.uploadedByUserId !== image.uploadedByUserId) return null;
  const current = targets(image);
  if (
    !current ||
    image.publishedRefCount !== 0 ||
    !isDeepStrictEqual(current, {
      storageProvider: parsed.data.storageProvider,
      storageFileIds: parsed.data.storageFileIds,
    })
  )
    return null;
  return parsed.data;
}

/** Caller holds the existing image mutex and has scanned references before begin. */
export async function runImageDeletion(
  store: ImageDeletionStore,
  input: ImageDeletionCommand,
): Promise<ImageDeletionResult> {
  const command = ImageDeletionCommandSchema.parse(input);
  const image = await store.get('images', command.imageId);
  if (!image) return { status: 'missing' };
  if (image._id !== command.imageId) return { status: 'corrupt' };
  if (command.action !== 'begin-orphan' && image.uploadedByUserId !== command.uploadedByUserId)
    return { status: 'forbidden' };
  if (image.status === 'deleted') {
    const intent = readImageDeletionIntent(image);
    if (!intent) return { status: 'corrupt' };
    if (command.action !== 'finish') return { status: 'ready', intent };
    if (intent.operationId !== command.operationId) return { status: 'conflict' };
    await store.remove('images', command.imageId);
    return { status: 'removed' };
  }
  if (command.action === 'finish') return { status: 'conflict' };
  if (command.action === 'begin-orphan') {
    if (
      (image.status !== 'pending' && image.status !== 'failed') ||
      Object.hasOwn(image, 'sourceMediaImport') ||
      typeof image.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(image.createdAt)) ||
      Date.parse(image.createdAt) >= Date.parse(command.cutoff)
    )
      return { status: 'conflict' };
  } else if (image.status !== 'active') return { status: 'conflict' };
  const lock = readImageMutationState(image);
  if (
    lock.state !== 'owned' ||
    lock.owner !== command.owner ||
    (command.action === 'begin-orphan'
      ? (image.publishedRefCount ?? 0) !== 0
      : image.publishedRefCount !== 0)
  )
    return { status: 'conflict' };
  const storage = targets(image);
  if (!storage) return { status: 'corrupt' };
  const parsedIntent = ImageDeletionIntentSchema.safeParse({
    schemaVersion:
      image.uploadedByUserId === undefined ? 'image-deletion-ownerless-v1' : 'image-deletion-v1',
    operationId: command.owner,
    uploadedByUserId: image.uploadedByUserId,
    startedAt: command.startedAt,
    ...storage,
  });
  if (!parsedIntent.success) return { status: 'corrupt' };
  const intent = parsedIntent.data;
  await store.set('images', {
    ...image,
    status: 'deleted',
    publishedRefCount: 0,
    imageDeletion: intent,
    updatedAt: command.startedAt,
  });
  return { status: 'ready', intent };
}

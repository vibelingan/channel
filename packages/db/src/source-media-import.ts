/** Atomic URL ownership and image activation; no external storage calls here. */
import { isDeepStrictEqual } from 'node:util';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import {
  CATALOG_IMAGE_MAX_BYTES,
  type CollectionDoc,
  alibabaPhotoSource,
} from '@vibelingan-channel/shared';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import { protectedImagePreservesOriginalTarget } from './catalog-image-protection.ts';
import {
  ImageDeletionIntentSchema,
  type ImageDeletionStore,
  readImageDeletionIntent,
} from './image-deletion.ts';

export const SOURCE_MEDIA_IMPORT_OWNER = 'alibaba-catalog-sync';
export const SOURCE_MEDIA_IMPORT_LEASE_MS = 120_000;
const token = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const time = z
  .string()
  .datetime()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const sourceUrl = z
  .string()
  .max(2048)
  .refine((value) => alibabaPhotoSource(value) === value);
const reason = z.enum([
  'invalid-url',
  'host-not-allowed',
  'dns-blocked',
  'too-many-redirects',
  'fetch-failed',
  'not-found',
  'too-large',
  'bad-content',
  'write-failed',
]);
const base = z.object({ sourceUrl, operationId: token, imageId: token, now: time });
export const SourceMediaTargetSchema = z
  .object({
    storageProvider: z.enum(['cloudbase-storage', 'local-disk']),
    storageMode: z.enum(['classic-nosql-storage', 'local-disk']),
    storageFileId: z.string().min(1).max(8192),
    storagePath: z.string().min(1).max(2048),
    byteSize: z.number().int().min(1).max(CATALOG_IMAGE_MAX_BYTES),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    name: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (value) => (value.storageProvider === 'local-disk') === (value.storageMode === 'local-disk'),
  );
export const SourceMediaImportCommandSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('claim') }).strict(),
  base.extend({ action: z.literal('checkpoint'), target: SourceMediaTargetSchema }).strict(),
  base.extend({ action: z.literal('activate'), target: SourceMediaTargetSchema }).strict(),
  base
    .extend({
      action: z.literal('reuse'),
      existingImageId: token,
      checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  base.extend({ action: z.literal('fail'), reason }).strict(),
  z
    .object({ action: z.literal('note-failure'), sourceUrl, operationId: token, reason, now: time })
    .strict(),
  z.object({ action: z.literal('retire'), imageId: token, owner: token, now: time }).strict(),
]);
const ownership = z
  .object({
    schemaVersion: z.literal('source-media-import-v1'),
    sourceUrl,
    operationId: token,
    imageId: token,
    startedAt: time,
    expiresAt: time,
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal('source-media-import-v1'),
    operationId: token,
    imageId: token,
  })
  .strict();
export type SourceMediaImportCommand = z.infer<typeof SourceMediaImportCommandSchema>;
export type SourceMediaTarget = z.infer<typeof SourceMediaTargetSchema>;
export type SourceMediaImportResult =
  | { status: 'ready'; imageId: string; deduplicated: boolean }
  | { status: 'claimed' | 'checkpointed' | 'failed' | 'retired' | 'noted' }
  | { status: 'busy' | 'conflict' | 'corrupt' | 'missing' };

function readOwnership(value: unknown) {
  const parsed = ownership.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function matchesClaim(value: unknown, command: z.infer<typeof base>) {
  const saved = readOwnership(value);
  return (
    !!saved &&
    saved.operationId === command.operationId &&
    saved.imageId === command.imageId &&
    saved.sourceUrl === command.sourceUrl
  );
}
function validLink(link: CollectionDoc | null, url: string) {
  return (
    !link ||
    (link._id === sourceMediaLinkId('alibaba', url) &&
      link.kind === 'media' &&
      link.provider === 'alibaba' &&
      link.sourceUrl === url)
  );
}
function activeImage(image: CollectionDoc | null, id: string): image is CollectionDoc {
  return (
    !!image &&
    image._id === id &&
    image.status === 'active' &&
    typeof image.storageFileId === 'string' &&
    image.storageFileId.length > 0 &&
    (image.storageProvider === 'cloudbase-storage' || image.storageProvider === 'local-disk')
  );
}
function withoutClaim(link: CollectionDoc) {
  const {
    mediaImport: _,
    mediaImportReceipt: _receipt,
    failedAt: __,
    failureReason: ___,
    imageId: ____,
    ...rest
  } = link;
  return rest;
}
function failureNote(
  link: CollectionDoc,
  operationId: string,
  failureReason: z.infer<typeof reason>,
  now: string,
): CollectionDoc {
  const value = link.failureAttempts;
  const previous =
    value === undefined
      ? 0
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 1;
  return {
    ...withoutClaim(link),
    lastFailureOperationId: operationId,
    failedAt: now,
    failureReason,
    failureAttempts:
      failureReason === 'write-failed' ? previous : Math.min(Number.MAX_SAFE_INTEGER, previous + 1),
    updatedAt: now,
  };
}
function pendingImage(
  image: CollectionDoc | null,
  command: z.infer<typeof base>,
): image is CollectionDoc {
  return (
    !!image &&
    image._id === command.imageId &&
    image.status === 'pending' &&
    image.uploadedByUserId === SOURCE_MEDIA_IMPORT_OWNER &&
    image.publishedRefCount === 0 &&
    matchesClaim(image.sourceMediaImport, command)
  );
}
function activeTargetMatches(image: CollectionDoc, target: SourceMediaTarget) {
  return Object.entries(target)
    .filter(([key]) => key !== 'name')
    .every(([key, value]) => isDeepStrictEqual(image[key], value));
}
function targetMatches(image: CollectionDoc, target: SourceMediaTarget) {
  return Object.entries(target).every(([key, value]) => isDeepStrictEqual(image[key], value));
}
function readyLink(
  link: CollectionDoc,
  imageId: string,
  operationId: string,
  now: string,
): CollectionDoc {
  return {
    ...withoutClaim(link),
    imageId,
    mediaImportReceipt: { schemaVersion: 'source-media-import-v1', operationId, imageId },
    updatedAt: now,
  };
}

/** Caller supplies one native transaction or the existing JSON mutation lock. */
export async function runSourceMediaImport(
  store: ImageDeletionStore,
  input: SourceMediaImportCommand,
): Promise<SourceMediaImportResult> {
  const command = SourceMediaImportCommandSchema.parse(input);
  if (command.action === 'retire') {
    const image = await store.get('images', command.imageId);
    if (!image) return { status: 'missing' };
    if (image._id !== command.imageId) return { status: 'corrupt' };
    if (image.status === 'deleted')
      return readImageDeletionIntent(image) ? { status: 'retired' } : { status: 'corrupt' };
    const owned = readOwnership(image.sourceMediaImport);
    if (
      !owned ||
      owned.imageId !== image._id ||
      image.uploadedByUserId !== SOURCE_MEDIA_IMPORT_OWNER ||
      image.publishedRefCount !== 0
    )
      return { status: 'corrupt' };
    if (image.status !== 'pending' && image.status !== 'failed') return { status: 'conflict' };
    if (owned.expiresAt > command.now) return { status: 'busy' };
    const lock = readImageMutationState(image);
    if (lock.state !== 'owned' || lock.owner !== command.owner) return { status: 'busy' };
    const linkId = sourceMediaLinkId('alibaba', owned.sourceUrl);
    const link = await store.get('catalogSourceLinks', linkId);
    if (!validLink(link, owned.sourceUrl)) return { status: 'corrupt' };
    const current =
      link && Object.hasOwn(link, 'mediaImport') ? readOwnership(link.mediaImport) : null;
    if (link && Object.hasOwn(link, 'mediaImport') && !current) return { status: 'corrupt' };
    if (
      current &&
      link &&
      (Object.hasOwn(link, 'imageId') || Object.hasOwn(link, 'mediaImportReceipt'))
    )
      return { status: 'corrupt' };
    const ownsLink = current?.operationId === owned.operationId && current.imageId === image._id;
    if (ownsLink && current.expiresAt > command.now) return { status: 'busy' };
    const fileId = image.storageFileId;
    if (
      fileId !== undefined &&
      (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 8192)
    )
      return { status: 'corrupt' };
    if (
      fileId !== undefined &&
      image.storageProvider !== 'local-disk' &&
      image.storageProvider !== 'cloudbase-storage'
    )
      return { status: 'corrupt' };
    const intent = ImageDeletionIntentSchema.parse({
      schemaVersion: 'image-deletion-v1',
      operationId: command.owner,
      uploadedByUserId: SOURCE_MEDIA_IMPORT_OWNER,
      startedAt: command.now,
      storageProvider: typeof image.storageProvider === 'string' ? image.storageProvider : '',
      storageFileIds: typeof fileId === 'string' ? [fileId] : [],
    });
    await store.set('images', {
      ...image,
      status: 'deleted',
      imageDeletion: intent,
      updatedAt: command.now,
    });
    if (ownsLink && link)
      await store.set(
        'catalogSourceLinks',
        failureNote(link, owned.operationId, 'write-failed', command.now),
      );
    return { status: 'retired' };
  }
  const linkId = sourceMediaLinkId('alibaba', command.sourceUrl);
  const link = await store.get('catalogSourceLinks', linkId);
  if (!validLink(link, command.sourceUrl)) return { status: 'corrupt' };
  const current =
    link && Object.hasOwn(link, 'mediaImport') ? readOwnership(link.mediaImport) : null;
  if (link && Object.hasOwn(link, 'mediaImport') && !current) return { status: 'corrupt' };
  if (
    current &&
    link &&
    (Object.hasOwn(link, 'imageId') || Object.hasOwn(link, 'mediaImportReceipt'))
  )
    return { status: 'corrupt' };
  let bound: CollectionDoc | null = null;
  if (typeof link?.imageId === 'string') bound = await store.get('images', link.imageId);
  const receipt =
    link && Object.hasOwn(link, 'mediaImportReceipt')
      ? receiptSchema.safeParse(link.mediaImportReceipt)
      : null;
  if (receipt && (!receipt.success || receipt.data.imageId !== link?.imageId))
    return { status: 'corrupt' };
  if (link && Object.hasOwn(link, 'imageId') && (typeof link.imageId !== 'string' || !link.imageId))
    return { status: 'corrupt' };
  if (bound && Object.hasOwn(bound, 'sourceMediaImport')) {
    const original = readOwnership(bound.sourceMediaImport);
    if (!original || original.imageId !== bound._id) return { status: 'corrupt' };
  }
  if (typeof link?.imageId === 'string' && activeImage(bound, link.imageId)) {
    const active = bound;
    async function ready(imageId: string, deduplicated: boolean): Promise<SourceMediaImportResult> {
      const lock = readImageMutationState(active);
      if (receipt?.success && lock.state === 'owned' && lock.owner === receipt.data.operationId)
        await store.set('images', {
          ...active,
          imageMutationOwner: '',
          imageMutationStartedAt: '',
        });
      return { status: 'ready', imageId, deduplicated };
    }
    if (command.action === 'note-failure')
      return { status: 'ready', imageId: active._id, deduplicated: true };
    if (command.action === 'claim') return ready(active._id, true);
    if (receipt?.success && receipt.data.operationId === command.operationId) {
      if (
        command.action === 'reuse' &&
        receipt.data.imageId === command.existingImageId &&
        bound.checksumSha256 === command.checksumSha256
      )
        return ready(command.existingImageId, true);
      if (
        (command.action === 'activate' || command.action === 'fail') &&
        receipt.data.imageId === command.imageId &&
        (command.action === 'fail' ||
          activeTargetMatches(bound, command.target) ||
          (await protectedImagePreservesOriginalTarget(store, bound, command.target)))
      )
        return ready(command.imageId, false);
    }
    return { status: 'conflict' };
  }
  if (command.action === 'note-failure') {
    if (current) return { status: 'busy' };
    if (link?.lastFailureOperationId === command.operationId) return { status: 'noted' };
    await store.set(
      'catalogSourceLinks',
      failureNote(
        link ?? { _id: linkId, kind: 'media', provider: 'alibaba', sourceUrl: command.sourceUrl },
        command.operationId,
        command.reason,
        command.now,
      ),
    );
    return { status: 'noted' };
  }
  const image = await store.get('images', command.imageId);
  if (command.action === 'claim') {
    if (current && matchesClaim(current, command))
      return pendingImage(image, command) ? { status: 'claimed' } : { status: 'corrupt' };
    if (current && current.expiresAt > command.now) return { status: 'busy' };
    if (image) return { status: 'conflict' };
    const owned = ownership.parse({
      schemaVersion: 'source-media-import-v1',
      sourceUrl: command.sourceUrl,
      operationId: command.operationId,
      imageId: command.imageId,
      startedAt: command.now,
      expiresAt: new Date(Date.parse(command.now) + SOURCE_MEDIA_IMPORT_LEASE_MS).toISOString(),
    });
    await store.set('images', {
      _id: command.imageId,
      purpose: 'catalog-image',
      uploadedByUserId: SOURCE_MEDIA_IMPORT_OWNER,
      status: 'pending',
      publishedRefCount: 0,
      sourceMediaImport: owned,
      createdAt: command.now,
      updatedAt: command.now,
    });
    await store.set('catalogSourceLinks', {
      ...withoutClaim(
        link ?? { _id: linkId, kind: 'media', provider: 'alibaba', sourceUrl: command.sourceUrl },
      ),
      mediaImport: owned,
      updatedAt: command.now,
    });
    return { status: 'claimed' };
  }
  if (
    command.action === 'fail' &&
    image?.status === 'failed' &&
    matchesClaim(image.sourceMediaImport, command) &&
    link?.lastFailureOperationId === command.operationId
  )
    return { status: 'failed' };
  if (!link || !matchesClaim(current, command) || !pendingImage(image, command))
    return { status: 'conflict' };
  if (readImageMutationState(image).state !== 'free') return { status: 'busy' };
  if (command.action === 'checkpoint') {
    if (Object.hasOwn(image, 'storageFileId') && !targetMatches(image, command.target))
      return { status: 'conflict' };
    const renewed = ownership.parse({
      ...current,
      expiresAt: new Date(Date.parse(command.now) + SOURCE_MEDIA_IMPORT_LEASE_MS).toISOString(),
    });
    await store.set('images', {
      ...image,
      ...command.target,
      sourceMediaImport: renewed,
      updatedAt: command.now,
    });
    await store.set('catalogSourceLinks', {
      ...link,
      mediaImport: renewed,
      updatedAt: command.now,
    });
    return { status: 'checkpointed' };
  }
  if (command.action === 'activate') {
    if (!targetMatches(image, command.target)) return { status: 'conflict' };
    await store.set('images', { ...image, status: 'active', updatedAt: command.now });
    await store.set(
      'catalogSourceLinks',
      readyLink(link, command.imageId, command.operationId, command.now),
    );
    return { status: 'ready', imageId: command.imageId, deduplicated: false };
  }
  if (command.action === 'reuse') {
    if (Object.hasOwn(image, 'storageFileId')) return { status: 'conflict' };
    const existing = await store.get('images', command.existingImageId);
    if (
      !activeImage(existing, command.existingImageId) ||
      existing.checksumSha256 !== command.checksumSha256
    )
      return { status: 'conflict' };
    const lock = readImageMutationState(existing);
    if (lock.state !== 'owned' || lock.owner !== command.operationId) return { status: 'busy' };
    // The same image row is physically fenced against deletion, not just read.
    await store.set('images', { ...existing, imageMutationOwner: '', imageMutationStartedAt: '' });
    await store.set(
      'catalogSourceLinks',
      readyLink(link, command.existingImageId, command.operationId, command.now),
    );
    await store.remove('images', command.imageId);
    return { status: 'ready', imageId: command.existingImageId, deduplicated: true };
  }
  await store.set('images', { ...image, status: 'failed', updatedAt: command.now });
  await store.set(
    'catalogSourceLinks',
    failureNote(link, command.operationId, command.reason, command.now),
  );
  return { status: 'failed' };
}

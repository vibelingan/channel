import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { readImageMutationState, transitionImageMutationAcquire } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from './catalog-image-input.ts';
import { CATALOG_IMAGE_OBSERVATIONS } from './catalog-image-observation.ts';
import {
  CATALOG_STORAGE_PROTECTION_POLICY,
  type CatalogImageProtectionIntent,
  CatalogImageProtectionIntentSchema,
  CatalogImageStorageProtectionSchema,
} from './catalog-image-protection-contract.ts';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobCommand,
  CatalogPreparationJobRecord,
  CatalogPreparationJobResult,
} from './catalog-preparation-jobs.ts';
import { retargetImageUploadCompletion } from './image-upload.ts';
type Command = Extract<
  CatalogPreparationJobCommand,
  {
    action:
      | 'begin-image-protection'
      | 'checkpoint-image-protection'
      | 'commit-image-protection'
      | 'release-image-protection';
  }
>;
type Input = { inputDigest: string; contentGeneration: number } | null | 'invalid';
const jobs = 'catalogPreparationJobs';
function identity(imageId: string, digest: string) {
  return alibabaPricingFingerprint([CATALOG_STORAGE_PROTECTION_POLICY, imageId, digest]);
}
function owner(jobId: string, leaseOwner: string, version: number) {
  return alibabaPricingFingerprint([CATALOG_STORAGE_PROTECTION_POLICY, jobId, leaseOwner, version]);
}
function fileName(mime: CatalogImageProtectionIntent['mimeType']) {
  return `original.${mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)}`;
}
function sourceRecord(i: CatalogImageProtectionIntent) {
  return {
    _id: i.imageId,
    status: 'active',
    storageProvider: i.sourceStorageProvider,
    ...(i.sourceStorageMode === null ? {} : { storageMode: i.sourceStorageMode }),
    storageFileId: i.sourceStorageFileId,
    ...(i.sourceStoragePath === null ? {} : { storagePath: i.sourceStoragePath }),
    mimeType: i.mimeType,
    byteSize: i.byteSize,
    checksumSha256: i.checksumSha256,
  };
}
export function readCatalogImageProtectionIntent(
  value: unknown,
  intentId: string,
): CatalogImageProtectionIntent | null {
  const r = CatalogImageProtectionIntentSchema.safeParse(value);
  if (!r.success) return null;
  const i = r.data;
  const path = catalogProtectedStoragePath(
    `${i.imageIdentity}:${i.checksumSha256}:${i.attemptId}`,
    fileName(i.mimeType),
  );
  return i._id === intentId &&
    identity(i.imageId, i.sourceInputDigest) === intentId &&
    i.imageIdentity === alibabaPricingFingerprint([i.imageId]) &&
    i.owner === owner(i.jobId, i.leaseOwner, i.leaseVersion) &&
    isStoredCatalogImageRecord(sourceRecord(i), i.imageId) &&
    storedCatalogImageInputDigest(sourceRecord(i)) === i.sourceInputDigest &&
    (!i.targetInputDigest ||
      i.targetInputDigest === storedCatalogImageInputDigest({ ...sourceRecord(i), ...i.target })) &&
    (!i.target ||
      (i.target.storagePath === path &&
        i.target.byteSize === i.byteSize &&
        (i.target.storageProvider !== 'local-disk' ||
          i.target.storageFileId === `local-disk:${path}`)))
    ? i
    : null;
}
function validIntent(value: unknown, intentId: string, now: number) {
  const intent = readCatalogImageProtectionIntent(value, intentId);
  return intent && Date.parse(intent.updatedAt) <= now + 5000 ? intent : null;
}

/** Current server-written target marker; not a pixel/readiness or publication grant. */
export function readCatalogImageStorageProtection(image: CollectionDoc | null) {
  if (!image || !isStoredCatalogImageRecord(image, image._id)) return null;
  const checked = CatalogImageStorageProtectionSchema.safeParse(image.catalogStorageProtection);
  if (!checked.success) return null;
  const marker = checked.data;
  const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.slice('image/'.length);
  const expected = catalogProtectedStoragePath(
    `${alibabaPricingFingerprint([image._id])}:${image.checksumSha256}:${marker.attemptId}`,
    `original.${extension}`,
  );
  return marker.imageId === image._id &&
    marker.targetInputDigest === storedCatalogImageInputDigest(image) &&
    image.storagePath === expected
    ? Object.freeze(marker)
    : null;
}

/** Recognize the exact old source target after a server-owned pointer repair, not arbitrary replacements. */
export async function protectedImagePreservesOriginalTarget(
  store: Pick<CatalogApprovalTransaction, 'get'>,
  image: CollectionDoc,
  target: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const marker = readCatalogImageStorageProtection(image);
  if (!marker) return false;
  const intent = readCatalogImageProtectionIntent(
    await store.get(CATALOG_IMAGE_OBSERVATIONS, marker.intentId),
    marker.intentId,
  );
  if (
    !intent ||
    intent.state !== 'committed' ||
    intent.imageId !== image._id ||
    intent.targetInputDigest !== marker.targetInputDigest ||
    intent.attemptId !== marker.attemptId
  )
    return false;
  const original: CollectionDoc = sourceRecord(intent);
  // Display names may be edited after activation; they are not byte/storage identity.
  return Object.entries(target)
    .filter(([key]) => key !== 'name')
    .every(([key, value]) => isDeepStrictEqual(original[key], value));
}

export async function runCatalogImageProtection(
  tx: CatalogApprovalTransaction,
  authority: CatalogPreparationAuthority,
  job: CatalogPreparationJobRecord,
  command: Command,
  now: number,
  initialTimestamp: string,
  readJob: (value: unknown, id: string, now: number) => CatalogPreparationJobRecord | null,
  currentInput: (tx: CatalogApprovalTransaction, productId: string) => Promise<Input>,
): Promise<CatalogPreparationJobResult> {
  const cleanup = command.action === 'release-image-protection';
  const scope = cleanup
    ? authority.cleanupLeaseScope(command.lease)
    : authority.currentLeaseScope(command.lease, job);
  if (!scope || scope.jobId !== job._id) return { ok: false, code: 'CONFLICT' };
  const own = owner(scope.jobId, scope.leaseOwner, scope.leaseVersion);
  const image = await tx.get('images', command.imageId);
  if (!image) return { ok: false, code: 'NOT_FOUND' };
  if (image._id !== command.imageId) return { ok: false, code: 'CORRUPT' };
  const imageDigest = storedCatalogImageInputDigest(image);
  const protectedMarker =
    command.action === 'begin-image-protection' ? readCatalogImageStorageProtection(image) : null;
  const intentId =
    command.action === 'begin-image-protection'
      ? (protectedMarker?.intentId ?? identity(command.imageId, command.imageInputDigest))
      : command.intentId;
  const raw = await tx.get(CATALOG_IMAGE_OBSERVATIONS, intentId);
  let intent = raw ? validIntent(raw, intentId, now) : null;
  if (raw && !intent) return { ok: false, code: 'CORRUPT' };
  if (command.action !== 'begin-image-protection' && !intent)
    return { ok: false, code: 'NOT_FOUND' };
  if (intent && intent.imageId !== command.imageId) return { ok: false, code: 'CONFLICT' };
  const timestamp = new Date(
    Math.max(Date.parse(initialTimestamp), Date.parse(intent?.updatedAt ?? initialTimestamp)),
  ).toISOString();
  const lock = readImageMutationState(image);
  if (lock.state === 'corrupt') return { ok: false, code: 'CORRUPT' };
  if (cleanup) {
    if (
      !intent ||
      intent.owner !== own ||
      intent.jobId !== scope.jobId ||
      intent.leaseVersion !== scope.leaseVersion ||
      intent.leaseOwner !== scope.leaseOwner
    )
      return { ok: false, code: 'CONFLICT' };
    if (lock.state === 'free') return { ok: true, protection: intent };
    if (lock.owner !== own) return { ok: false, code: 'CONFLICT' };
    await tx.set('images', { ...image, imageMutationOwner: '', imageMutationStartedAt: '' });
    return { ok: true, protection: intent };
  }
  if (!isStoredCatalogImageRecord(image, command.imageId)) return { ok: false, code: 'CORRUPT' };
  if (command.action === 'begin-image-protection') {
    if (imageDigest !== command.imageInputDigest) return { ok: false, code: 'CONFLICT' };
    if (intent?.state === 'committed') {
      if (
        !protectedMarker ||
        intent.targetInputDigest !== imageDigest ||
        protectedMarker.attemptId !== intent.attemptId
      )
        return { ok: false, code: 'CORRUPT' };
    } else {
      if (lock.state === 'owned' && lock.owner !== own) {
        let reclaim = false;
        if (intent && intent.owner === lock.owner) {
          const old = readJob(await tx.get(jobs, intent.jobId), intent.jobId, now);
          if (!old) return { ok: false, code: 'CORRUPT' };
          reclaim =
            old.state !== 'running' ||
            old.leaseVersion !== intent.leaseVersion ||
            old.leaseOwner !== intent.leaseOwner ||
            old.leaseExpiresAt <= now;
        }
        if (!reclaim && transitionImageMutationAcquire(image, own, timestamp).result !== 'acquired')
          return { ok: false, code: 'BUSY' };
      }
      const nextIntent = CatalogImageProtectionIntentSchema.safeParse(
        intent
          ? {
              ...intent,
              jobId: job._id,
              leaseVersion: job.leaseVersion,
              leaseOwner: job.leaseOwner,
              owner: own,
              updatedAt: timestamp,
            }
          : {
              _id: intentId,
              kind: 'catalog-image-protection-intent-v1',
              policyVersion: CATALOG_STORAGE_PROTECTION_POLICY,
              imageId: command.imageId,
              imageIdentity: alibabaPricingFingerprint([command.imageId]),
              sourceInputDigest: imageDigest,
              sourceStorageProvider: image.storageProvider,
              sourceStorageMode: image.storageMode ?? null,
              sourceStorageFileId: image.storageFileId,
              sourceStoragePath: image.storagePath ?? null,
              mimeType: image.mimeType,
              byteSize: image.byteSize,
              checksumSha256: image.checksumSha256,
              attemptId: randomBytes(32).toString('hex'),
              state: 'reserved',
              jobId: job._id,
              leaseVersion: job.leaseVersion,
              leaseOwner: job.leaseOwner,
              owner: own,
              target: null,
              targetInputDigest: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
      );
      if (!nextIntent.success) return { ok: false, code: 'CORRUPT' };
      intent = nextIntent.data;
    }
  } else {
    if (!intent) return { ok: false, code: 'NOT_FOUND' };
    if (intent.state === 'committed' && command.action === 'commit-image-protection') {
      const marker = CatalogImageStorageProtectionSchema.safeParse(image.catalogStorageProtection);
      if (
        imageDigest !== intent.targetInputDigest ||
        !marker.success ||
        marker.data.intentId !== intentId ||
        marker.data.imageId !== command.imageId ||
        marker.data.attemptId !== intent.attemptId ||
        marker.data.targetInputDigest !== imageDigest ||
        command.health.status !== 'verified' ||
        command.health.imageId !== command.imageId ||
        command.health.inputDigest !== imageDigest ||
        command.health.byteSize !== intent.byteSize ||
        command.health.checksumSha256 !== intent.checksumSha256
      )
        return { ok: false, code: 'CONFLICT' };
    } else if (
      lock.state !== 'owned' ||
      lock.owner !== own ||
      intent.owner !== own ||
      intent.jobId !== job._id ||
      intent.leaseVersion !== job.leaseVersion ||
      image.catalogProtectionIntentId !== intentId ||
      imageDigest !== intent.sourceInputDigest
    )
      return { ok: false, code: 'CONFLICT' };
  }
  const current = await currentInput(tx, job.productId);
  if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
  if (
    !current ||
    current === 'invalid' ||
    current.inputDigest !== job.inputDigest ||
    current.contentGeneration !== job.contentGeneration
  ) {
    await tx.set(jobs, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      state: 'stale',
      leaseOwner: '',
      leaseExpiresAt: 0,
      updatedAt: timestamp,
    });
    return { ok: false, code: 'STALE' };
  }
  if (!intent) return { ok: false, code: 'CORRUPT' };
  if (command.action === 'begin-image-protection') {
    if (intent.state === 'committed') return { ok: true, protection: intent };
    await tx.set(jobs, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    await tx.set(CATALOG_IMAGE_OBSERVATIONS, intent);
    await tx.set('images', {
      ...image,
      catalogProtectionIntentId: intentId,
      imageMutationOwner: own,
      imageMutationStartedAt: timestamp,
    });
  } else if (command.action === 'checkpoint-image-protection') {
    const expected = catalogProtectedStoragePath(
      `${intent.imageIdentity}:${intent.checksumSha256}:${intent.attemptId}`,
      fileName(intent.mimeType),
    );
    if (
      command.target.storagePath !== expected ||
      command.target.byteSize !== intent.byteSize ||
      (command.target.storageProvider === 'local-disk' &&
        command.target.storageFileId !== `local-disk:${expected}`) ||
      (intent.target && !isDeepStrictEqual(intent.target, command.target))
    )
      return { ok: false, code: 'CONFLICT' };
    intent = { ...intent, state: 'targeted', target: command.target, updatedAt: timestamp };
    await tx.set(jobs, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    await tx.set(CATALOG_IMAGE_OBSERVATIONS, intent);
  } else {
    if (intent.state === 'committed') return { ok: true, protection: intent };
    if (!intent.target || command.health.status !== 'verified')
      return { ok: false, code: 'CONFLICT' };
    const next = retargetImageUploadCompletion(image, { ...image, ...intent.target });
    const targetDigest = storedCatalogImageInputDigest(next);
    if (
      command.health.imageId !== command.imageId ||
      command.health.inputDigest !== targetDigest ||
      command.health.byteSize !== intent.byteSize ||
      command.health.checksumSha256 !== intent.checksumSha256
    )
      return { ok: false, code: 'CONFLICT' };
    const marker = CatalogImageStorageProtectionSchema.parse({
      kind: 'catalog-protected-target-v1',
      intentId,
      imageId: command.imageId,
      attemptId: intent.attemptId,
      targetInputDigest: targetDigest,
    });
    intent = {
      ...intent,
      state: 'committed',
      targetInputDigest: targetDigest,
      updatedAt: timestamp,
    };
    const { catalogProtectionIntentId: _pending, ...clean } = next;
    await tx.set(jobs, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    await tx.set(CATALOG_IMAGE_OBSERVATIONS, intent);
    await tx.set('images', {
      ...clean,
      catalogStorageProtection: marker,
      imageMutationOwner: '',
      imageMutationStartedAt: '',
    });
  }
  return { ok: true, protection: CatalogImageProtectionIntentSchema.parse(intent) };
}

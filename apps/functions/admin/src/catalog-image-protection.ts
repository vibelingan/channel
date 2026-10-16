import { isDeepStrictEqual } from 'node:util';
import { get, manageCatalogPreparationJob } from '@vibelingan-channel/db';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from '@vibelingan-channel/db/catalog-image-input';
import {
  type CatalogImageProtectionIntent,
  CatalogProtectedTargetSchema,
} from '@vibelingan-channel/db/catalog-image-protection-contract';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobResult,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { inspectStoredCatalogImage } from './catalog-image-bytes.ts';
import {
  type StoredCatalogImageHealth,
  readStoredCatalogImageHealth,
} from './catalog-image-health.ts';

type Scope = Readonly<{ jobId: string; lease: object; imageId: string }>;
type Checked = Readonly<{ imageInputDigest: string | null; health: StoredCatalogImageHealth }>;
function failure(
  result: Extract<CatalogPreparationJobResult, { ok: false }>,
): StoredCatalogImageHealth {
  if (result.code === 'CORRUPT') return { status: 'invalid', reason: 'record' };
  return {
    status: 'retry',
    reason:
      result.code === 'BUSY'
        ? 'busy'
        : result.code === 'STALE' || result.code === 'CONFLICT'
          ? 'changed'
          : 'unavailable',
  };
}
/** Copy only under a tracked server lease. This prepares one image, not the product or publication. */
export async function prepareStoredCatalogImage(
  authority: CatalogPreparationAuthority,
  scope: Scope,
): Promise<Checked> {
  const run = (command: Parameters<typeof manageCatalogPreparationJob>[1]) =>
    manageCatalogPreparationJob(authority, command);
  let inputDigest: string | null = null;
  const state: { intentId: string | null } = { intentId: null };
  let commitAttempted = false;
  let beginAttempted = false;
  const checked = (health: StoredCatalogImageHealth): Checked => ({
    imageInputDigest: inputDigest,
    health,
  });
  async function work(): Promise<Checked> {
    const original = await get('images', scope.imageId);
    const originalDigest = original ? storedCatalogImageInputDigest(original) : null;
    inputDigest = originalDigest;
    if (!isStoredCatalogImageRecord(original, scope.imageId) || originalDigest === null)
      return checked({ status: 'invalid', reason: 'record' });
    beginAttempted = true;
    const begun = await run({
      action: 'begin-image-protection',
      ...scope,
      imageInputDigest: originalDigest,
    });
    if (!begun.ok) return checked(failure(begun));
    if (!('protection' in begun)) return checked({ status: 'retry', reason: 'unavailable' });
    if (begun.protection.state === 'committed')
      return checked(await readStoredCatalogImageHealth(scope.imageId));
    const reserved = begun.protection;
    state.intentId = reserved._id;
    let bindingChanged = false;
    // A pending target has no public image row. Only this exact lock/metadata pair may project it for readback.
    async function boundImage(
      target: CatalogImageProtectionIntent['target'],
    ): Promise<CollectionDoc | null> {
      const current = await get('images', scope.imageId);
      if (
        !isStoredCatalogImageRecord(current, scope.imageId) ||
        storedCatalogImageInputDigest(current) !== reserved.sourceInputDigest ||
        current.imageMutationOwner !== reserved.owner ||
        current.catalogProtectionIntentId !== reserved._id
      ) {
        bindingChanged = true;
        return null;
      }
      return { ...current, ...target, imageMutationOwner: '', imageMutationStartedAt: '' };
    }
    async function readTarget(target: NonNullable<CatalogImageProtectionIntent['target']>) {
      const health = await readStoredCatalogImageHealth(scope.imageId, {
        getImage: () => boundImage(target),
      });
      return bindingChanged ? { status: 'retry' as const, reason: 'changed' as const } : health;
    }
    let target = reserved.target;
    let health = target ? await readTarget(target) : null;
    if (bindingChanged) return checked({ status: 'retry', reason: 'changed' });
    if (!health || health.status !== 'verified') {
      const source = await inspectStoredCatalogImage(
        scope.imageId,
        (_proof, bytes, mimeType) => ({ bytes, mimeType }),
        { getImage: () => boundImage(null) },
      );
      if (bindingChanged) return checked({ status: 'retry', reason: 'changed' });
      if (!('bytes' in source)) return checked(source);
      const extension =
        source.mimeType === 'image/jpeg' ? 'jpg' : source.mimeType.slice('image/'.length);
      let registered: CatalogImageProtectionIntent['target'] = null;
      const stored = await mediaStorage().putObject(
        {
          namespace: 'catalog-sealed',
          logicalId: `${reserved.imageIdentity}:${reserved.checksumSha256}:${reserved.attemptId}`,
          fileName: `original.${extension}`,
          mimeType: source.mimeType,
          content: source.bytes,
        },
        {
          beforeWrite: async (actual) => {
            const permanent = CatalogProtectedTargetSchema.parse(actual);
            if (permanent.byteSize !== source.bytes.length)
              throw Error('Protected target size mismatch');
            const saved = await run({
              action: 'checkpoint-image-protection',
              ...scope,
              intentId: reserved._id,
              target: permanent,
            });
            if (
              !saved.ok ||
              !('protection' in saved) ||
              !isDeepStrictEqual(saved.protection.target, permanent)
            )
              throw Error('Protected target checkpoint failed');
            registered = permanent;
          },
        },
      );
      if (!registered || !isDeepStrictEqual(stored, registered))
        throw Error('Protected target acknowledgement mismatch');
      target = registered;
      health = await readTarget(target);
    }
    // Pixel invalidity follows checksum-verified source bytes. A bad target transfer does not invalidate the original.
    if (health?.status === 'invalid' && health.reason !== 'content')
      return checked({ status: 'retry', reason: 'unavailable' });
    if (!health || health.status !== 'verified')
      return checked(health ?? { status: 'retry', reason: 'unavailable' });
    commitAttempted = true;
    const committed = await run({
      action: 'commit-image-protection',
      ...scope,
      intentId: reserved._id,
      health,
    });
    if (!committed.ok) return checked(failure(committed));
    if (
      !('protection' in committed) ||
      committed.protection.state !== 'committed' ||
      committed.protection.targetInputDigest !== health.inputDigest
    )
      return checked({ status: 'retry', reason: 'unavailable' });
    inputDigest = health.inputDigest;
    return checked(await readStoredCatalogImageHealth(scope.imageId));
  }
  let result: Checked;
  try {
    result = await work();
  } catch {
    result = checked({ status: 'retry', reason: 'unavailable' });
    if (beginAttempted && (commitAttempted || state.intentId === null))
      try {
        const image = await get('images', scope.imageId);
        if (
          isStoredCatalogImageRecord(image, scope.imageId) &&
          (commitAttempted || storedCatalogImageInputDigest(image) === inputDigest)
        ) {
          const digest = storedCatalogImageInputDigest(image);
          const recovered = await run({
            action: 'begin-image-protection',
            ...scope,
            imageInputDigest: digest,
          });
          if (
            recovered.ok &&
            'protection' in recovered &&
            (recovered.protection._id === state.intentId || state.intentId === null)
          ) {
            state.intentId = recovered.protection._id;
            if (recovered.protection.state === 'committed') {
              inputDigest = digest;
              result = checked(await readStoredCatalogImageHealth(scope.imageId));
            }
          }
        }
      } catch {
        result = checked({ status: 'retry', reason: 'unavailable' });
      }
  }
  if (state.intentId)
    try {
      const released = await run({
        action: 'release-image-protection',
        ...scope,
        intentId: state.intentId,
      });
      if (!released.ok) return checked({ status: 'retry', reason: 'unavailable' });
    } catch {
      return checked({ status: 'retry', reason: 'unavailable' });
    }
  return result;
}

/** Expiry cleanup shares the finalizer's mutex and persists quarantine before bytes. */
import { randomUUID } from 'node:crypto';
import {
  acquireImageMutation,
  executeImageDeletion,
  get,
  manageImageDeletion,
  readImageMutationState,
  releaseImageMutation,
} from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
export async function cleanupOrphanUploadImage(imageId: string, cutoff: string) {
  const storageDeleted: string[] = [];
  const finish = (status: 'deleted' | 'missing' | 'busy' | 'changed' | 'failed') => ({
    status,
    storageDeleted,
  });
  const owner = randomUUID();
  let locked = false;
  try {
    const image = await get('images', imageId);
    if (!image) return finish('missing');
    if (
      image._id !== imageId ||
      Object.hasOwn(image, 'sourceMediaImport') ||
      !['pending', 'failed', 'deleted'].includes(String(image.status))
    )
      return finish('changed');
    if (image.status !== 'deleted') {
      try {
        locked =
          (await acquireImageMutation(imageId, owner, new Date().toISOString())) === 'acquired';
      } catch {
        const current = await get('images', imageId);
        const lock = current ? readImageMutationState(current) : null;
        locked = current?._id === imageId && lock?.state === 'owned' && lock.owner === owner;
      }
      if (!locked) return finish('busy');
    }
    const result = await executeImageDeletion(
      { manage: manageImageDeletion, get: (id) => get('images', id) },
      { action: 'begin-orphan', imageId, owner, cutoff, startedAt: new Date().toISOString() },
      async (id) => {
        await mediaStorage().deleteObject(id);
        storageDeleted.push(id);
      },
    );
    return finish(
      result === 'deleted' || result === 'missing'
        ? result
        : result === 'conflict'
          ? 'changed'
          : 'failed',
    );
  } catch {
    return finish('failed');
  } finally {
    if (locked)
      await releaseImageMutation(imageId, owner)
        .catch(() => releaseImageMutation(imageId, owner))
        .catch(() => {});
  }
}

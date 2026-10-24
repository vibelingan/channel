/** Cleanup for service-owned copies; pending activation and retirement share one image row. */
import { randomUUID } from 'node:crypto';
import {
  SOURCE_MEDIA_IMPORT_OWNER,
  acquireImageMutation,
  executeImageDeletion,
  get,
  manageImageDeletion,
  manageSourceMediaImport,
  readImageMutationState,
  releaseImageMutation,
} from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';

type CleanupStatus = 'deleted' | 'missing' | 'busy' | 'changed' | 'corrupt' | 'failed';

export async function cleanupSourceMediaImage(
  imageId: string,
  now = new Date().toISOString(),
): Promise<{ status: CleanupStatus; storageDeleted: string[] }> {
  const storageDeleted: string[] = [];
  const finish = (status: CleanupStatus) => ({ status, storageDeleted });
  const owner = randomUUID();
  let locked = false;
  try {
    const image = await get('images', imageId);
    if (!image) return finish('missing');
    if (image.uploadedByUserId !== SOURCE_MEDIA_IMPORT_OWNER) return finish('changed');
    if (image.status !== 'deleted') {
      if (!Object.hasOwn(image, 'sourceMediaImport')) return finish('changed');
      try {
        locked = (await acquireImageMutation(imageId, owner, now)) === 'acquired';
      } catch {
        const current = await get('images', imageId);
        const lock = current ? readImageMutationState(current) : null;
        locked = lock?.state === 'owned' && lock.owner === owner;
      }
      if (!locked) return finish('busy');
      const command = { action: 'retire', imageId, owner, now } as const;
      const retired = await manageSourceMediaImport(command).catch(() =>
        manageSourceMediaImport(command),
      );
      if (retired.status === 'missing') return finish('missing');
      if (retired.status !== 'retired')
        return finish(
          retired.status === 'busy'
            ? 'busy'
            : retired.status === 'conflict'
              ? 'changed'
              : retired.status === 'corrupt'
                ? 'corrupt'
                : 'failed',
        );
    }
    const result = await executeImageDeletion(
      { manage: manageImageDeletion, get: (id) => get('images', id) },
      {
        action: 'begin',
        imageId,
        uploadedByUserId: SOURCE_MEDIA_IMPORT_OWNER,
        owner,
        startedAt: now,
      },
      async (id) => {
        await mediaStorage().deleteObject(id);
        storageDeleted.push(id);
      },
    );
    return finish(result === 'deleted' || result === 'missing' ? result : 'failed');
  } catch {
    return finish('failed');
  } finally {
    if (locked)
      await releaseImageMutation(imageId, owner)
        .catch(() => releaseImageMutation(imageId, owner))
        .catch(() => {});
  }
}

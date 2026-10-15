/** One resumable teardown. Unknown database outcomes are resolved by read-back. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type ImageDeletionCommand,
  type ImageDeletionResult,
  readImageDeletionIntent,
} from './image-deletion.ts';

export interface ImageDeletionPersistence {
  manage(command: ImageDeletionCommand): Promise<ImageDeletionResult>;
  get(imageId: string): Promise<CollectionDoc | null>;
}
export async function executeImageDeletion(
  persistence: ImageDeletionPersistence,
  command: Extract<ImageDeletionCommand, { action: 'begin' | 'begin-orphan' }>,
  deleteObject: (fileId: string) => Promise<void>,
): Promise<'deleted' | 'missing' | 'forbidden' | 'conflict' | 'corrupt' | 'failed'> {
  let result: ImageDeletionResult;
  try {
    result = await persistence.manage(command);
  } catch {
    // Never destroy bytes based on an in-memory intent or an unknown write ACK.
    let image: CollectionDoc | null;
    try {
      image = await persistence.get(command.imageId);
    } catch {
      return 'failed';
    }
    if (!image) return 'missing';
    if (image._id !== command.imageId) return 'corrupt';
    if (command.action === 'begin' && image.uploadedByUserId !== command.uploadedByUserId)
      return 'forbidden';
    const intent = readImageDeletionIntent(image);
    if (!intent) return 'failed';
    result = { status: 'ready', intent };
  }
  if (result.status !== 'ready') return result.status === 'removed' ? 'deleted' : result.status;
  for (const fileId of result.intent.storageFileIds) {
    try {
      await deleteObject(fileId);
    } catch {
      return 'failed';
    }
  }
  try {
    const finished = await persistence.manage({
      action: 'finish',
      imageId: command.imageId,
      uploadedByUserId: result.intent.uploadedByUserId,
      operationId: result.intent.operationId,
    });
    return finished.status === 'removed' || finished.status === 'missing' ? 'deleted' : 'failed';
  } catch {
    try {
      return (await persistence.get(command.imageId)) === null ? 'deleted' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

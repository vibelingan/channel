/**
 * Thin naming seam over the trusted repository facade. Every read/write this
 * function performs goes through @vibelingan-channel/db (never an SDK
 * directly), and the sync worker only ever uses the TRUSTED paths — the
 * registry write-schema applies to generic admin CRUD, not here.
 */
import {
  createDoc as createDocTrusted,
  createDocWithId as createDocWithIdFacade,
  get,
  incrementField as incrementFieldFacade,
  list,
  remove,
  updateDoc as updateDocTrusted,
  upsertDocWithId as upsertDocWithIdFacade,
} from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';

export type { CollectionDoc };

export function getDoc(collection: string, id: string): Promise<CollectionDoc | null> {
  return get(collection, id);
}

export function createDoc(
  collection: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc> {
  return createDocTrusted(collection, data);
}

export function updateDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc | null> {
  return updateDocTrusted(collection, id, data);
}

export function removeDoc(collection: string, id: string): Promise<boolean> {
  return remove(collection, id);
}

export function incrementField(
  collection: string,
  id: string,
  field: string,
  delta: number,
): Promise<number | null> {
  return incrementFieldFacade(collection, id, field, delta);
}

export function createDocWithId(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<'created' | 'exists'> {
  return createDocWithIdFacade(collection, id, data);
}

export function upsertDocWithId(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<CollectionDoc> {
  return upsertDocWithIdFacade(collection, id, data);
}

/** First page of a collection ordered by `expiresAt` ascending (sweeps). */
export async function listDocs(collection: string, limit: number): Promise<CollectionDoc[]> {
  const result = await list({
    collection,
    page: 1,
    pageSize: limit,
    sort: [{ field: 'expiresAt', dir: 'asc' }],
  });
  return [...result.items];
}

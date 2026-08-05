/**
 * Storage adapter abstraction.
 *
 * The repository in `index.ts` never talks to a database directly — it talks to
 * a `DbAdapter`. Production wires the CloudBase (wx-server-sdk) adapter; local
 * development wires a file-backed adapter. This keeps the persistence layer
 * swappable without any module-aliasing tricks.
 */
import type {
  CollectionDoc,
  FilterModel,
  ListQuery,
  ListResult,
  SortClause,
} from '@vibelingan-channel/shared';

/** Normalized query passed to adapters: defaults already applied. */
export interface AdapterListQuery {
  collection: string;
  page: number;
  pageSize: number;
  search: string;
  filter?: FilterModel;
  sort?: SortClause[];
}

export type ImageMutationAcquireResult = 'acquired' | 'missing' | 'busy' | 'corrupt';
export type ImageMutationReleaseResult = 'released' | 'missing' | 'not-owner' | 'corrupt';

/**
 * A lock older than this is treated as abandoned by a crashed holder and may
 * be taken over. Far beyond any CloudBase function timeout (60s), so a live
 * holder can never be preempted; short enough that a crash does not require
 * manual database surgery to unstick the image.
 */
export const IMAGE_MUTATION_STALE_MS = 15 * 60_000;
export type ImageMutationState =
  | { state: 'free' }
  | { state: 'owned'; owner: string; startedAt: string }
  | { state: 'corrupt' };
export type ImageMutationAcquireTransition =
  | { result: 'acquired'; patch: { imageMutationOwner: string; imageMutationStartedAt: string } }
  | { result: 'busy' | 'corrupt' };
export type ImageMutationReleaseTransition =
  | { result: 'released'; patch: { imageMutationOwner: ''; imageMutationStartedAt: '' } }
  | { result: 'not-owner' | 'corrupt' };

export function readImageMutationState(doc: CollectionDoc): ImageMutationState {
  const owner = doc.imageMutationOwner;
  const startedAt = doc.imageMutationStartedAt;
  const startedAtMs = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  if ((owner === undefined && startedAt === undefined) || (owner === '' && startedAt === '')) {
    return { state: 'free' };
  }
  if (
    typeof owner === 'string' &&
    owner.length > 0 &&
    typeof startedAt === 'string' &&
    Number.isFinite(startedAtMs) &&
    new Date(startedAt).toISOString() === startedAt
  ) {
    return { state: 'owned', owner, startedAt };
  }
  return { state: 'corrupt' };
}

export function transitionImageMutationAcquire(
  doc: CollectionDoc,
  owner: string,
  startedAt: string,
): ImageMutationAcquireTransition {
  const lock = readImageMutationState(doc);
  if (lock.state === 'corrupt') return { result: 'corrupt' };
  if (lock.state === 'owned') {
    // Stale-holder takeover: a crashed function can never release its lock,
    // and no admin surface exposes the fields. Canonical ISO strings compare
    // lexicographically, so this needs no Date parsing.
    const staleBefore = new Date(Date.parse(startedAt) - IMAGE_MUTATION_STALE_MS).toISOString();
    if (lock.startedAt >= staleBefore) return { result: 'busy' };
  }
  return {
    result: 'acquired',
    patch: { imageMutationOwner: owner, imageMutationStartedAt: startedAt },
  };
}

export function transitionImageMutationRelease(
  doc: CollectionDoc,
  owner: string,
): ImageMutationReleaseTransition {
  const lock = readImageMutationState(doc);
  if (lock.state === 'corrupt') return { result: 'corrupt' };
  if (lock.state !== 'owned' || lock.owner !== owner) return { result: 'not-owner' };
  return {
    result: 'released',
    patch: { imageMutationOwner: '', imageMutationStartedAt: '' },
  };
}

export interface DbAdapter {
  list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>>;
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  /** Find the first document where `field` exactly equals `value`. */
  findByField(collection: string, field: string, value: unknown): Promise<CollectionDoc | null>;
  create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null>;
  remove(collection: string, id: string): Promise<boolean>;
  /**
   * Atomically add `delta` to one numeric field of a document and return the
   * new value, or `null` if the document does not exist. A trusted server-side
   * primitive for maintaining server-managed counters (e.g.
   * `images.publishedRefCount`) that are read-only on the generic write surface.
   */
  incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null>;
  /**
   * Acquire exclusive ownership of all reference/lifecycle mutation for one
   * managed image. Transitional optional surface until test adapters upgrade.
   */
  acquireImageMutation?(
    imageId: string,
    owner: string,
    startedAt: string,
  ): Promise<ImageMutationAcquireResult>;
  /** Release only when the caller still owns the image mutation lock. */
  releaseImageMutation?(imageId: string, owner: string): Promise<ImageMutationReleaseResult>;
}

// Re-exported so callers building queries can reference the input shape.
export type { ListQuery };

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
import {
  normalizeProductSlug,
  normalizeSkuCode,
  validateProductPublication,
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

export interface CatalogProductSaveInput {
  mode: 'create' | 'update';
  productId: string;
  data: Record<string, unknown>;
}

export interface CatalogProductIdentity {
  kind: 'slug' | 'sku';
  normalizedValue: string;
  id: string;
}

export type CatalogProductSaveResult =
  | { result: 'saved'; doc: CollectionDoc; previous: CollectionDoc | null }
  | { result: 'conflict'; kind: 'slug' | 'sku'; normalizedValue: string }
  | { result: 'invalid'; kind: 'slug' | 'sku' }
  | { result: 'invalid-product'; issues: ReturnType<typeof validateProductPublication> }
  | { result: 'missing' | 'exists' };

export type CatalogProductSavePlan =
  | Extract<
      CatalogProductSaveResult,
      { result: 'invalid' | 'invalid-product' | 'missing' | 'exists' }
    >
  | {
      result: 'ready';
      doc: CollectionDoc;
      identities: CatalogProductIdentity[];
      staleIdentities: CatalogProductIdentity[];
    };

function productIdentity(
  kind: 'slug' | 'sku',
  value: unknown,
): CatalogProductIdentity | null | 'invalid' {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const normalizedValue = kind === 'slug' ? normalizeProductSlug(value) : normalizeSkuCode(value);
  if (normalizedValue === null) return 'invalid';
  return { kind, normalizedValue, id: `${kind}:${normalizedValue}` };
}

function productIdentities(
  values: Record<string, unknown>,
): CatalogProductIdentity[] | { invalid: 'slug' | 'sku' } {
  const slug = productIdentity('slug', values.slug);
  if (slug === 'invalid') return { invalid: 'slug' };
  const sku = productIdentity('sku', values.skuCode);
  if (sku === 'invalid') return { invalid: 'sku' };
  return [slug, sku].filter((identity): identity is CatalogProductIdentity => identity !== null);
}

function validProductIdentities(values: Record<string, unknown>): CatalogProductIdentity[] {
  return (['slug', 'sku'] as const)
    .map((kind) => productIdentity(kind, kind === 'slug' ? values.slug : values.skuCode))
    .filter(
      (identity): identity is CatalogProductIdentity => identity !== null && identity !== 'invalid',
    );
}

export function planCatalogProductSave(
  existing: CollectionDoc | null,
  input: CatalogProductSaveInput,
  now: string,
): CatalogProductSavePlan {
  if (input.mode === 'create' && existing) return { result: 'exists' };
  if (input.mode === 'update' && !existing) return { result: 'missing' };
  const { _id, ...inputData } = input.data as Record<string, unknown> & { _id?: unknown };
  const data =
    input.mode === 'create'
      ? { published: false, archived: false, ...inputData }
      : { ...inputData };
  if (input.mode === 'update' && Object.hasOwn(data, 'archived')) {
    const wasArchived = existing?.archived === true;
    const willBeArchived = data.archived === true;
    if (wasArchived !== willBeArchived) data.published = false;
  }
  const doc = {
    ...(existing ?? {}),
    ...data,
    _id: input.productId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } as CollectionDoc;
  const issues = validateProductPublication(doc);
  if (issues.length > 0) return { result: 'invalid-product', issues };
  const identities = productIdentities(doc);
  if (!Array.isArray(identities)) return { result: 'invalid', kind: identities.invalid };
  const previousIdentities = existing ? validProductIdentities(existing) : [];
  const nextIds = new Set(identities.map((identity) => identity.id));
  return {
    result: 'ready',
    doc,
    identities,
    staleIdentities: previousIdentities.filter((identity) => !nextIds.has(identity.id)),
  };
}

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

// ---------------------------------------------------------------------------
// Alibaba sync lease (docs/alibaba-linked-catalog-sync/ARCHITECTURE.md §9)
//
// Same architecture as the image-mutation lock above: ONE pure transition
// state machine shared by every adapter, with each adapter supplying only its
// atomicity envelope (CloudBase runTransaction / local JSON withMutationLock).
// Unlike the image lock, this lease is FENCED: every acquisition after a
// release/expiry increments a fence token, and guarded writes re-verify
// holder+fence+expiry INSIDE the same transaction as the write
// (updateDocWithAlibabaLease) — assert-then-write is forbidden for guarded
// state (REVISION_R1 E2).
// ---------------------------------------------------------------------------

/** Lease TTL; a holder that stops heartbeating loses the lease after this. */
export const ALIBABA_SYNC_LEASE_TTL_MS = 180_000;
/** Heartbeat cadence; renew this often and before long operations. */
export const ALIBABA_SYNC_LEASE_RENEW_MS = 60_000;
/** Collection the lease documents live in (doc id = connectionId). */
export const ALIBABA_SYNC_LEASE_COLLECTION = 'alibabaSyncLeases';

export interface AlibabaLeaseGuard {
  connectionId: string;
  holder: string;
  fence: number;
  /** Canonical ISO instant used for the expiry comparison. */
  now: string;
}

export type AlibabaLeaseGrant =
  | { result: 'granted'; fence: number }
  | { result: 'busy' }
  | { result: 'corrupt' };

export type AlibabaLeaseState =
  | { state: 'absent' }
  | { state: 'held'; holder: string; fence: number; expiresAt: string; released: boolean }
  | { state: 'corrupt' };

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function readAlibabaLeaseState(doc: CollectionDoc | null): AlibabaLeaseState {
  if (doc === null) return { state: 'absent' };
  const { holder, fence, expiresAt, releasedAt } = doc;
  if (
    typeof holder === 'string' &&
    holder.length > 0 &&
    typeof fence === 'number' &&
    Number.isSafeInteger(fence) &&
    fence >= 1 &&
    isCanonicalIso(expiresAt) &&
    (releasedAt === undefined || releasedAt === '' || isCanonicalIso(releasedAt))
  ) {
    const released = typeof releasedAt === 'string' && releasedAt.length > 0;
    return { state: 'held', holder, fence, expiresAt, released };
  }
  return { state: 'corrupt' };
}

export type AlibabaLeaseAcquireTransition =
  | { result: 'granted'; fence: number; doc: Record<string, unknown> }
  | { result: 'busy' }
  | { result: 'corrupt' };

export function transitionAlibabaLeaseAcquire(
  existing: CollectionDoc | null,
  holder: string,
  now: string,
  ttlMs: number,
): AlibabaLeaseAcquireTransition {
  const lease = readAlibabaLeaseState(existing);
  if (lease.state === 'corrupt') return { result: 'corrupt' };
  let fence = 1;
  if (lease.state === 'held') {
    // Canonical ISO compares lexicographically; a live, unreleased lease that
    // has not reached its expiry instant blocks acquisition.
    if (!lease.released && lease.expiresAt > now) return { result: 'busy' };
    fence = lease.fence + 1;
  }
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  return {
    result: 'granted',
    fence,
    doc: {
      holder,
      fence,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      releasedAt: '',
    },
  };
}

export type AlibabaLeaseUpdateTransition =
  | { result: 'applied'; patch: Record<string, unknown> }
  | { result: 'rejected' };

export function transitionAlibabaLeaseRenew(
  existing: CollectionDoc | null,
  holder: string,
  fence: number,
  now: string,
  ttlMs: number,
): AlibabaLeaseUpdateTransition {
  if (!holdsAlibabaLease(existing, holder, fence, now)) return { result: 'rejected' };
  return {
    result: 'applied',
    patch: { heartbeatAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() },
  };
}

export function transitionAlibabaLeaseRelease(
  existing: CollectionDoc | null,
  holder: string,
  fence: number,
  now: string,
): AlibabaLeaseUpdateTransition {
  const lease = readAlibabaLeaseState(existing);
  if (lease.state !== 'held' || lease.holder !== holder || lease.fence !== fence) {
    return { result: 'rejected' };
  }
  // Idempotent: releasing an already-released lease you owned succeeds without
  // rewriting the release instant. Expiry does NOT block release — a holder
  // that overran its TTL but has not been fenced over may still clean up.
  if (lease.released) return { result: 'applied', patch: {} };
  return { result: 'applied', patch: { releasedAt: now } };
}

/** True iff `holder`+`fence` currently hold a live, unreleased, unexpired lease. */
export function holdsAlibabaLease(
  existing: CollectionDoc | null,
  holder: string,
  fence: number,
  now: string,
): boolean {
  const lease = readAlibabaLeaseState(existing);
  return (
    lease.state === 'held' &&
    lease.holder === holder &&
    lease.fence === fence &&
    !lease.released &&
    lease.expiresAt > now
  );
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
  /**
   * Create a document with a caller-chosen deterministic id; 'exists' when the
   * id is already taken (single-winner create-if-absent). Optional surface —
   * the facade throws when the adapter lacks it (acquireImageMutation
   * precedent).
   */
  createDocWithId?(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'>;
  /** Delete by id only while one field still equals the expected owner value. */
  removeDocIfFieldEquals?(
    collection: string,
    id: string,
    field: string,
    expectedValue: unknown,
  ): Promise<boolean>;
  /** Atomically save one product and transfer its slug/SKU reservations. */
  saveCatalogProductWithIdentities?(
    input: CatalogProductSaveInput,
  ): Promise<CatalogProductSaveResult>;
  /** Create-or-patch by deterministic id; returns the resulting document. */
  upsertDocWithId?(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc>;
  /** Transactionally acquire the per-connection sync lease (fence increments on takeover). */
  acquireAlibabaSyncLease?(
    connectionId: string,
    holder: string,
    now: string,
    ttlMs: number,
  ): Promise<AlibabaLeaseGrant>;
  /** Extend the lease's expiry; false when holder/fence no longer hold it. */
  renewAlibabaSyncLease?(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
    ttlMs: number,
  ): Promise<boolean>;
  /** Release the lease held by holder+fence (idempotent); false on mismatch. */
  releaseAlibabaSyncLease?(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
  ): Promise<boolean>;
  /**
   * Fenced conditional write (REVISION_R1 E2): verify the lease INSIDE the
   * same transaction/critical section as the target-document patch. Returns
   * false — writing nothing — when the guard no longer holds or the target is
   * missing.
   */
  updateDocWithAlibabaLease?(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean>;
}

// Re-exported so callers building queries can reference the input shape.
export type { ListQuery };

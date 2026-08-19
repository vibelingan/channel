import * as cloudbase from '@cloudbase/node-sdk';
import type { CloudBase } from '@cloudbase/node-sdk';
import {
  type CollectionDoc,
  type FilterClause,
  type ListResult,
  getCollection,
} from '@vibelingan-channel/shared';
/**
 * CloudBase (wx-server-sdk) implementation of `DbAdapter`.
 *
 * Used in production cloud functions. Call `initCloudBase(envId)` once at module
 * load before the adapter is used.
 */
import cloud from 'wx-server-sdk';
import type {
  AlibabaLeaseGrant,
  CatalogProductSaveResult,
  DbAdapter,
  ImageMutationAcquireResult,
  ImageMutationReleaseResult,
} from './adapter.ts';
import {
  ALIBABA_SYNC_LEASE_COLLECTION,
  holdsAlibabaLease,
  planCatalogProductSave,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from './adapter.ts';

/*
 * wx-server-sdk@4 ships official types, but every terminal database call is
 * typed for the dual callback/promise API (`Promise<T> | void | string`) and
 * its IDatabaseConfig omits the runtime-honored `throwOnNotFound` flag. The
 * adapter uses the promise style exclusively, so the exact surface it consumes
 * is typed structurally here and asserted against the installed SDK at runtime
 * by scripts/verify-cloudbase-sdk-contract.mjs.
 */
interface WxDocumentReference {
  get(): Promise<{ data: Record<string, unknown> | Record<string, unknown>[] | null }>;
  update(options: { data: Record<string, unknown> }): Promise<{ updated: number }>;
  remove(): Promise<{ deleted: number }>;
}

interface WxQuery {
  where(condition: Record<string, unknown>): WxQuery;
  orderBy(field: string, order: 'asc' | 'desc'): WxQuery;
  skip(offset: number): WxQuery;
  limit(count: number): WxQuery;
  get(): Promise<{ data: Record<string, unknown>[] }>;
  count(): Promise<{ total: number }>;
}

interface WxCollectionReference extends WxQuery {
  doc(id: string): WxDocumentReference;
  add(options: { data: Record<string, unknown> }): Promise<{ _id: string }>;
}

interface WxCommand {
  or(conditions: Record<string, unknown>[]): Record<string, unknown>;
  and(conditions: Record<string, unknown>[]): Record<string, unknown>;
  eq(value: unknown): unknown;
  neq(value: unknown): unknown;
  gt(value: unknown): unknown;
  gte(value: unknown): unknown;
  lt(value: unknown): unknown;
  lte(value: unknown): unknown;
  in(values: unknown[]): unknown;
  nin(values: unknown[]): unknown;
  /**
   * Update command: replace a field WHOLESALE instead of the default
   * dot-path merge. Present on the installed wx-server-sdk 4.0.2 command
   * (probed in scripts/verify-cloudbase-sdk-contract.mjs); the local
   * interface simply had not declared it.
   */
  set(value: unknown): unknown;
}

interface WxDatabase {
  collection(name: string): WxCollectionReference;
  command: WxCommand;
  RegExp(options: { regexp: string; options?: string }): unknown;
}

/**
 * The @cloudbase/node-sdk transaction surface the lock methods use. node-sdk
 * 3.x types the runTransaction callback parameter loosely, so the shape is
 * pinned structurally here (and probed by the SDK contract script).
 */
interface NodeSdkTransaction {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ data: unknown }>;
      update(patch: Record<string, unknown>): Promise<unknown>;
      /**
       * Full-replace upsert: `database.modifyDocument` with
       * `{merge:false, upsert:true, transactionId, query:{_id}}`. The data
       * object must NOT contain `_id` (the SDK rejects it). Verified against
       * the installed @cloudbase/database 1.4.3 source and probed by
       * scripts/verify-cloudbase-sdk-contract.mjs.
       */
      set(data: Record<string, unknown>): Promise<{ updated?: number }>;
      remove(): Promise<{ deleted?: number }>;
    };
  };
}

let initialized = false;
let storageApp: CloudBase | null = null;

export function initCloudBase(envId: string): void {
  if (initialized) return;
  cloud.init({ env: envId });
  storageApp = cloudbase.init({ env: envId });
  initialized = true;
}

/**
 * The initialised CloudBase node-sdk instance, exposed for media-storage
 * injection. `wx-server-sdk` wraps only part of the storage API and does not
 * expose `getUploadMetadata`; upload-intent minting must use @cloudbase/node-sdk
 * directly while the DB adapter still uses wx-server-sdk.
 */
export function cloudStorageSdk(): CloudBase {
  if (!storageApp) {
    throw new Error(
      '@vibelingan-channel/db: initCloudBase(envId) must be called before using storage',
    );
  }
  return storageApp;
}

function database(): WxDatabase {
  if (!initialized) {
    throw new Error(
      '@vibelingan-channel/db: initCloudBase(envId) must be called before using the database',
    );
  }
  // throwOnNotFound DEFAULTS TO TRUE in wx-server-sdk: without this config a
  // missing `doc(id).get()` rejects with "document with _id ... does not
  // exist" instead of resolving `{ data: null }`. Every `get() -> null`
  // missing-document contract in the handlers depends on this being false.
  // (IDatabaseConfig omits the flag, hence the parameter cast.)
  const config = { throwOnNotFound: false } as Parameters<typeof cloud.database>[0];
  return cloud.database(config) as unknown as WxDatabase;
}

function normalize(raw: Record<string, unknown>): CollectionDoc {
  return raw as CollectionDoc;
}

function normalizeSingle(raw: unknown): CollectionDoc | null {
  const doc = Array.isArray(raw) ? raw[0] : raw;
  return doc && typeof doc === 'object' && !Array.isArray(doc)
    ? normalize(doc as Record<string, unknown>)
    : null;
}

export const cloudBaseAdapter: DbAdapter = {
  async list(query): Promise<ListResult<CollectionDoc>> {
    const db = database();
    const def = getCollection(query.collection);
    const collection = db.collection(query.collection);
    const _ = db.command;

    const ands: Record<string, unknown>[] = [];

    // Free-text search across the collection's searchable fields.
    if (query.search && def && def.searchableFields.length > 0) {
      const term = db.RegExp({ regexp: escapeRegExp(query.search), options: 'i' });
      ands.push(_.or(def.searchableFields.map((field) => ({ [field]: term }))));
    }

    // Structured filter (field/operator/value clauses combined with AND/OR).
    if (query.filter && query.filter.clauses.length > 0) {
      const clauseWheres = query.filter.clauses
        .map((c) => clauseToWhere(db, _, c))
        .filter((w): w is Record<string, unknown> => w !== null);
      if (clauseWheres.length > 0) {
        ands.push(query.filter.combinator === 'or' ? _.or(clauseWheres) : _.and(clauseWheres));
      }
    }

    const where = ands.length === 0 ? undefined : ands.length === 1 ? ands[0] : _.and(ands);

    const base = where ? collection.where(where) : collection;
    const countRes = await base.count();
    const total = countRes.total ?? 0;

    // Apply sort (default: newest first), then page.
    let q = base;
    const sort =
      query.sort && query.sort.length > 0
        ? query.sort
        : [{ field: 'createdAt', dir: 'desc' as const }];
    for (const s of sort) {
      q = q.orderBy(s.field, s.dir);
    }

    const skip = (query.page - 1) * query.pageSize;
    const res = await q.skip(skip).limit(query.pageSize).get();

    return {
      items: (res.data as Record<string, unknown>[]).map(normalize),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  async get(collection, id): Promise<CollectionDoc | null> {
    const db = database();
    // With `throwOnNotFound: false` (set in database()), a missing document
    // resolves `{ data: null }`. Do not catch transport/database failures as
    // if they meant "missing"; destructive callers must fail closed on an
    // uncertain read.
    const res = await db.collection(collection).doc(id).get();
    return normalizeSingle(res.data);
  },

  async findByField(collection, field, value): Promise<CollectionDoc | null> {
    const db = database();
    const res = await db
      .collection(collection)
      .where({ [field]: value })
      .limit(1)
      .get();
    const raw = (res.data as Record<string, unknown>[])[0];
    return raw ? normalize(raw) : null;
  },

  async create(collection, data): Promise<CollectionDoc> {
    const db = database();
    const now = new Date().toISOString();
    const doc = { ...data, createdAt: now, updatedAt: now };
    const res = await db.collection(collection).add({ data: doc });
    return normalize({ _id: res._id as string, ...doc });
  },

  async update(collection, id, data): Promise<CollectionDoc | null> {
    const db = database();
    const patch = { ...data, updatedAt: new Date().toISOString() };
    await db
      .collection(collection)
      .doc(id)
      .update({ data: replaceNestedObjects(patch, db.command) });
    return this.get(collection, id);
  },

  async remove(collection, id): Promise<boolean> {
    const db = database();
    const res = await db.collection(collection).doc(id).remove();
    return (res.deleted ?? 0) > 0;
  },

  async incrementField(collection, id, field, delta): Promise<number | null> {
    // The atomic increment MUST go through @cloudbase/node-sdk, NOT wx-server-sdk.
    // In the Tencent CloudBase runtime, wx-server-sdk's command-based update
    // (`.doc(id).update({ data: { f: db.command.inc(n) } })`) returns `updated: 0`
    // and does not apply — while PLAIN wx updates work. That silently broke every
    // `incrementField` caller: the OEM `finalizeClaim` single-winner claim (hard
    // `NOT_FOUND` → all OEM submissions failed) and `images.publishedRefCount`
    // (masked by the delivery legacy-scan fallback). Diagnosed live 2026-07-01.
    // node-sdk is the native SDK for this runtime and its `command.inc` applies;
    // its `.update(data)` takes the patch directly (no `data:` wrapper) and
    // `.get()` returns `{ data: [doc] }`. Re-read via the SAME sdk so the returned
    // counter value reflects this write (read-after-write).
    const db = cloudStorageSdk().database();
    const ref = db.collection(collection).doc(id);
    const res = await ref.update({ [field]: db.command.inc(delta), updatedAt: new Date().toISOString() });
    if ((res.updated ?? 0) === 0) return null;
    const got = await ref.get();
    const doc = (got.data as Record<string, unknown>[] | undefined)?.[0];
    const value = doc ? Number(doc[field]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  },

  async acquireImageMutation(imageId, owner, startedAt): Promise<ImageMutationAcquireResult> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection('images').doc(imageId);
      const got = await ref.get();
      const doc = normalizeSingle(got.data);
      if (!doc) return 'missing';
      const transition = transitionImageMutationAcquire(doc, owner, startedAt);
      if (transition.result !== 'acquired') return transition.result;
      await ref.update({
        ...transition.patch,
        updatedAt: new Date().toISOString(),
      });
      return 'acquired';
    });
  },

  async releaseImageMutation(imageId, owner): Promise<ImageMutationReleaseResult> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection('images').doc(imageId);
      const got = await ref.get();
      const doc = normalizeSingle(got.data);
      if (!doc) return 'missing';
      const transition = transitionImageMutationRelease(doc, owner);
      if (transition.result !== 'released') return transition.result;
      await ref.update({
        ...transition.patch,
        updatedAt: new Date().toISOString(),
      });
      return 'released';
    });
  },

  // -------------------------------------------------------------------------
  // Deterministic-id writes + Alibaba sync lease (ARCHITECTURE §9).
  // Every method is ONE runTransaction whose callback is a pure
  // read-check-write: runTransaction re-executes the callback on
  // DATABASE_TRANSACTION_CONFLICT, so callbacks must have no side effects
  // outside the transaction.
  // -------------------------------------------------------------------------

  async createDocWithId(collection, id, data): Promise<'created' | 'exists'> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(collection).doc(id);
      const got = await ref.get();
      if (normalizeSingle(got.data)) return 'exists';
      // set() is a full-replace upsert keyed by the doc id; _id must not
      // appear in the payload (SDK contract, probed in CI).
      const { _id, ...payload } = data as Record<string, unknown> & { _id?: unknown };
      await ref.set(payload);
      return 'created';
    });
  },

  async removeDocIfFieldEquals(collection, id, field, expectedValue): Promise<boolean> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(collection).doc(id);
      const got = await ref.get();
      const existing = normalizeSingle(got.data);
      if (!existing || existing[field] !== expectedValue) return false;
      const removed = await ref.remove();
      return (removed.deleted ?? 0) > 0;
    });
  },

  async saveCatalogProductWithIdentities(input): Promise<CatalogProductSaveResult> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const productRef = transaction.collection('products').doc(input.productId);
      const existing = normalizeSingle((await productRef.get()).data);
      const now = new Date().toISOString();
      const plan = planCatalogProductSave(existing, input, now);
      if (plan.result !== 'ready') return plan;

      const identityById = new Map<string, CollectionDoc | null>();
      for (const identity of [...plan.identities, ...plan.staleIdentities]) {
        if (!identityById.has(identity.id)) {
          const ref = transaction.collection('catalogProductIdentities').doc(identity.id);
          identityById.set(identity.id, normalizeSingle((await ref.get()).data));
        }
      }
      for (const identity of plan.identities) {
        const existingIdentity = identityById.get(identity.id);
        if (
          existingIdentity &&
          (existingIdentity.productId !== input.productId ||
            existingIdentity.kind !== identity.kind ||
            existingIdentity.normalizedValue !== identity.normalizedValue)
        ) {
          return {
            result: 'conflict',
            kind: identity.kind,
            normalizedValue: identity.normalizedValue,
          };
        }
      }

      for (const identity of plan.identities) {
        if (!identityById.get(identity.id)) {
          await transaction.collection('catalogProductIdentities').doc(identity.id).set({
            kind: identity.kind,
            normalizedValue: identity.normalizedValue,
            productId: input.productId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      const { _id, ...productData } = plan.doc;
      if (input.mode === 'create') {
        await productRef.set(productData);
      } else {
        if (existing?.createdAt !== undefined && existing.createdAt !== null) {
          delete productData.createdAt;
        }
        await productRef.update(replaceNestedObjects(productData, db.command));
      }
      for (const identity of plan.staleIdentities) {
        if (identityById.get(identity.id)?.productId === input.productId) {
          await transaction.collection('catalogProductIdentities').doc(identity.id).remove();
        }
      }
      return { result: 'saved', doc: plan.doc };
    });
  },

  async upsertDocWithId(collection, id, data): Promise<CollectionDoc> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(collection).doc(id);
      const got = await ref.get();
      const existing = normalizeSingle(got.data);
      const now = new Date().toISOString();
      const { _id, ...patch } = data as Record<string, unknown> & { _id?: unknown };
      if (existing) {
        const merged = { ...patch, updatedAt: now };
        await ref.update(replaceNestedObjects(merged, db.command));
        return normalize({ ...existing, ...merged, _id: id });
      }
      const created = { createdAt: now, updatedAt: now, ...patch };
      await ref.set(created);
      return normalize({ _id: id, ...created });
    });
  },

  async acquireAlibabaSyncLease(connectionId, holder, now, ttlMs): Promise<AlibabaLeaseGrant> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(ALIBABA_SYNC_LEASE_COLLECTION).doc(connectionId);
      const got = await ref.get();
      const transition = transitionAlibabaLeaseAcquire(
        normalizeSingle(got.data),
        holder,
        now,
        ttlMs,
      );
      if (transition.result !== 'granted') return { result: transition.result };
      await ref.set({ ...transition.doc, updatedAt: now });
      return { result: 'granted', fence: transition.fence };
    });
  },

  async renewAlibabaSyncLease(connectionId, holder, fence, now, ttlMs): Promise<boolean> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(ALIBABA_SYNC_LEASE_COLLECTION).doc(connectionId);
      const got = await ref.get();
      const transition = transitionAlibabaLeaseRenew(
        normalizeSingle(got.data),
        holder,
        fence,
        now,
        ttlMs,
      );
      if (transition.result !== 'applied') return false;
      await ref.update({ ...transition.patch, updatedAt: now });
      return true;
    });
  },

  async releaseAlibabaSyncLease(connectionId, holder, fence, now): Promise<boolean> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      const ref = transaction.collection(ALIBABA_SYNC_LEASE_COLLECTION).doc(connectionId);
      const got = await ref.get();
      const transition = transitionAlibabaLeaseRelease(
        normalizeSingle(got.data),
        holder,
        fence,
        now,
      );
      if (transition.result !== 'applied') return false;
      if (Object.keys(transition.patch).length > 0) {
        await ref.update({ ...transition.patch, updatedAt: now });
      }
      return true;
    });
  },

  async updateDocWithAlibabaLease(collection, id, patch, guard): Promise<boolean> {
    const db = cloudStorageSdk().database();
    return db.runTransaction(async (transaction: NodeSdkTransaction) => {
      // The fence recheck lives INSIDE the same transaction as the write —
      // assert-then-update at the caller would be check-then-act (R1 E2).
      const leaseRef = transaction
        .collection(ALIBABA_SYNC_LEASE_COLLECTION)
        .doc(guard.connectionId);
      const lease = normalizeSingle((await leaseRef.get()).data);
      if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
      const targetRef = transaction.collection(collection).doc(id);
      if (!normalizeSingle((await targetRef.get()).data)) return false;
      await targetRef.update(replaceNestedObjects({ ...patch, updatedAt: guard.now }, db.command));
      return true;
    });
  },
};

/**
 * CloudBase's `update` FLATTENS a nested plain object into dot-paths
 * (`UpdateSerializer.encodeUpdateObject` -> `flattenQueryObject`), which is a
 * MERGE, not a replace. Two consequences the local JSON adapter never shows,
 * because it shallow-spreads:
 *   1. Writing `{a:{x:1}}` over a field currently holding `null` targets
 *      `a.x` on a non-object and does not land.
 *   2. A patch that omits a sub-key leaves the PREVIOUS value's sub-key in
 *      place — `{mode:'tiered',tiers}` followed by `{mode:'fixed',amountMinor}`
 *      yields a document carrying both, so a consumer reading by `mode` sees
 *      fields that contradict it.
 * Wrapping object values in the `set` update command replaces the field
 * wholesale, which is the semantics every caller in this repo assumes.
 *
 * Arrays are left alone (CloudBase already replaces them wholesale), and so is
 * anything that is not a PLAIN object — an update command such as
 * `command.inc(n)` is a class instance and must reach the driver untouched.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function replaceNestedObjects(
  patch: Record<string, unknown>,
  command: { set(value: unknown): unknown },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) ? command.set(value) : value;
  }
  return out;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate one filter clause into a wx-server-sdk `where` fragment. */
function clauseToWhere(
  db: WxDatabase,
  _: WxCommand,
  clause: FilterClause,
): Record<string, unknown> | null {
  const { field, op, value } = clause;
  switch (op) {
    case 'eq':
      return { [field]: _.eq(value) };
    case 'ne':
      return { [field]: _.neq(value) };
    case 'contains':
      return { [field]: db.RegExp({ regexp: escapeRegExp(String(value ?? '')), options: 'i' }) };
    case 'startsWith':
      return {
        [field]: db.RegExp({ regexp: `^${escapeRegExp(String(value ?? ''))}`, options: 'i' }),
      };
    case 'gt':
      return { [field]: _.gt(value) };
    case 'gte':
      return { [field]: _.gte(value) };
    case 'lt':
      return { [field]: _.lt(value) };
    case 'lte':
      return { [field]: _.lte(value) };
    case 'in':
      return { [field]: _.in(Array.isArray(value) ? value : [value]) };
    case 'isEmpty':
      return { [field]: _.in(['', null]) };
    case 'isNotEmpty':
      return { [field]: _.nin(['', null]) };
    default:
      return null;
  }
}

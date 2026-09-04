/**
 * File-backed implementation of `DbAdapter` for local development.
 *
 * Persists every collection to a single JSON file so edits made through the
 * admin UI survive restarts — a lightweight stand-in for the remote CloudBase
 * database. One process owns each database file; in-process reads/writes are
 * serialized and persisted by same-directory atomic rename.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ALIBABA_SYNC_LEASE_COLLECTION,
  type AdapterListQuery,
  type AlibabaLeaseGrant,
  type AlibabaLeaseGuard,
  type AlibabaSyncRunClaimResult,
  type CatalogProductSaveInput,
  type CatalogProductSaveResult,
  type CatalogSourceObservationUpsertResult,
  type DbAdapter,
  type ImageMutationAcquireResult,
  type ImageMutationReleaseResult,
  holdsAlibabaLease,
  nextCounterValue,
  planCatalogProductSave,
  transitionAlibabaLeaseAcquire,
  transitionAlibabaLeaseRelease,
  transitionAlibabaLeaseRenew,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  getCollection,
  matchesFilter,
  normalizeProductSlug,
  normalizeSkuCode,
} from '@vibelingan-channel/shared';

type Store = Record<string, CollectionDoc[]>;

const mutationQueues = new Map<string, Promise<void>>();
const ownedDatabaseFiles = new Set<string>();
let ownerCleanupRegistered = false;

function parseStore(raw: string): Store {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Local database root must be an object of collection arrays.');
  }
  for (const [collection, rows] of Object.entries(parsed)) {
    if (
      !Array.isArray(rows) ||
      rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))
    ) {
      throw new Error(`Local database collection ${collection} must be an array of objects.`);
    }
  }
  return parsed as Store;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function ownerFileFor(file: string): string {
  return `${file}.owner`;
}

function parseStoreOwner(raw: string): { pid: number } {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('pid' in parsed) ||
    typeof parsed.pid !== 'number' ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    throw new Error('Local database owner file is invalid.');
  }
  return { pid: parsed.pid };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

/** Read a small marker file, mapping ENOENT to null. */
function readMarkerFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function registerOwnerCleanup(): void {
  if (ownerCleanupRegistered) return;
  ownerCleanupRegistered = true;
  process.once('exit', () => {
    for (const file of ownedDatabaseFiles) {
      const ownerFile = ownerFileFor(file);
      try {
        const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: unknown };
        if (owner.pid === process.pid) rmSync(ownerFile, { force: true });
      } catch {
        // A malformed/replaced owner file is not ours to remove.
      }
    }
  });
}

export class JsonFileAdapter implements DbAdapter {
  private readonly file: string;
  private store: Store;

  constructor(file: string) {
    this.file = resolve(file);
    this.claimProcessOwnership();
    this.store = this.load();
  }

  private claimProcessOwnership(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const ownerFile = ownerFileFor(this.file);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), {
          encoding: 'utf8',
          flag: 'wx',
        });
        ownedDatabaseFiles.add(this.file);
        registerOwnerCleanup();
        return;
      } catch (error) {
        if (!isErrnoCode(error, 'EEXIST')) throw error;
      }
      const raw = readMarkerFile(ownerFile);
      if (raw === null) continue;
      let ownerPid: number | null;
      try {
        ownerPid = parseStoreOwner(raw).pid;
      } catch {
        // A malformed owner file (torn write from a crashed claimant) is
        // stale; it is only ever removed through the verified takeover below.
        ownerPid = null;
      }
      if (ownerPid === process.pid) {
        ownedDatabaseFiles.add(this.file);
        registerOwnerCleanup();
        return;
      }
      if (ownerPid !== null && processIsAlive(ownerPid)) {
        throw new Error(`Local database is already owned by process ${ownerPid}.`);
      }
      this.removeStaleOwner(ownerFile, raw);
    }
    throw new Error('Could not claim local database process ownership.');
  }

  /**
   * Remove a stale (dead-pid or malformed) owner file without the blind-delete
   * race: two concurrent claimants may both observe the same dead owner, and an
   * unconditional delete lets the loser remove the winner's freshly written
   * claim, leaving BOTH processes convinced they own the store. Deletion
   * therefore happens only while holding an exclusively created (`wx`)
   * takeover mutex, and only after re-verifying the owner file still holds the
   * exact stale content originally observed.
   */
  private removeStaleOwner(ownerFile: string, observedRaw: string): void {
    const takeoverFile = `${ownerFile}.takeover`;
    try {
      writeFileSync(takeoverFile, JSON.stringify({ pid: process.pid }), {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
      // Another process is mid-takeover. If it crashed there, clear its stale
      // mutex; the owner file itself stays protected by wx + re-verify.
      const takeoverRaw = readMarkerFile(takeoverFile);
      let takeoverPid: number | null = null;
      if (takeoverRaw !== null) {
        try {
          takeoverPid = parseStoreOwner(takeoverRaw).pid;
        } catch {
          takeoverPid = null;
        }
      }
      if (takeoverPid === null || !processIsAlive(takeoverPid)) {
        rmSync(takeoverFile, { force: true });
      }
      return;
    }
    try {
      if (readMarkerFile(ownerFile) === observedRaw) rmSync(ownerFile, { force: true });
    } finally {
      rmSync(takeoverFile, { force: true });
    }
  }

  private load(): Store {
    try {
      return parseStore(readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return {};
      }
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryFile, JSON.stringify(this.store, null, 2), 'utf8');
      renameSync(temporaryFile, this.file);
    } finally {
      rmSync(temporaryFile, { force: true });
    }
  }

  private docs(collection: string): CollectionDoc[] {
    if (!this.store[collection]) this.store[collection] = [];
    return this.store[collection];
  }

  private async withMutationLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = mutationQueues.get(this.file) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    mutationQueues.set(this.file, tail);
    await previous;
    try {
      this.store = this.load();
      return await operation();
    } finally {
      release?.();
      if (mutationQueues.get(this.file) === tail) mutationQueues.delete(this.file);
    }
  }

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    return this.withMutationLock(() => {
      const def = getCollection(query.collection);
      let docs = [...this.docs(query.collection)];

      if (query.productFamily) {
        docs = docs.filter((doc) =>
          matchesFilter(doc, {
            combinator: 'and',
            clauses: [
              {
                field: 'productFamily',
                op: 'matchesProductFamily',
                value: query.productFamily,
              },
            ],
          }),
        );
      }

      if (query.search && def) {
        const needle = query.search.toLowerCase();
        docs = docs.filter((doc) =>
          def.searchableFields.some((field) =>
            String(doc[field] ?? '')
              .toLowerCase()
              .includes(needle),
          ),
        );
      }

      if (query.filter && query.filter.clauses.length > 0) {
        const filter = query.filter;
        docs = docs.filter((doc) => matchesFilter(doc, filter));
      }

      if (query.sort && query.sort.length > 0) {
        const sort = query.sort;
        docs.sort((a, b) => compareBySort(a, b, sort));
      } else {
        docs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      }

      const total = docs.length;
      const start = (query.page - 1) * query.pageSize;
      const items = docs.slice(start, start + query.pageSize);
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
  }

  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.withMutationLock(() => this.docs(collection).find((d) => d._id === id) ?? null);
  }

  async findByField(
    collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.withMutationLock(
      () => this.docs(collection).find((d) => d[field] === value) ?? null,
    );
  }

  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    return this.withMutationLock(() => {
      const now = new Date().toISOString();
      const doc: CollectionDoc = { _id: randomUUID(), ...data, createdAt: now, updatedAt: now };
      this.docs(collection).push(doc);
      this.persist();
      return doc;
    });
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      const index = docs.findIndex((d) => d._id === id);
      if (index === -1) return null;
      const existing = docs[index] as CollectionDoc;
      const updated: CollectionDoc = { ...existing, ...data, updatedAt: new Date().toISOString() };
      docs[index] = updated;
      this.persist();
      return updated;
    });
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      const index = docs.findIndex((d) => d._id === id);
      if (index === -1) return false;
      docs.splice(index, 1);
      this.persist();
      return true;
    });
  }

  async incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      const index = docs.findIndex((d) => d._id === id);
      if (index === -1) return null;
      const existing = docs[index] as CollectionDoc;
      const next = nextCounterValue(existing[field], delta);
      docs[index] = { ...existing, [field]: next, updatedAt: new Date().toISOString() };
      this.persist();
      return next;
    });
  }

  async acquireImageMutation(
    imageId: string,
    owner: string,
    startedAt: string,
  ): Promise<ImageMutationAcquireResult> {
    return this.withMutationLock(() => {
      const docs = this.docs('images');
      const index = docs.findIndex((document) => document._id === imageId);
      if (index < 0) return 'missing';
      const existing = docs[index] as CollectionDoc;
      const transition = transitionImageMutationAcquire(existing, owner, startedAt);
      if (transition.result !== 'acquired') return transition.result;
      docs[index] = { ...existing, ...transition.patch };
      this.persist();
      return 'acquired';
    });
  }

  async releaseImageMutation(imageId: string, owner: string): Promise<ImageMutationReleaseResult> {
    return this.withMutationLock(() => {
      const docs = this.docs('images');
      const index = docs.findIndex((document) => document._id === imageId);
      if (index < 0) return 'missing';
      const existing = docs[index] as CollectionDoc;
      const transition = transitionImageMutationRelease(existing, owner);
      if (transition.result !== 'released') return transition.result;
      docs[index] = { ...existing, ...transition.patch };
      this.persist();
      return 'released';
    });
  }

  // Deterministic-id writes + Alibaba sync lease (ARCHITECTURE §9). Each
  // method is ONE withMutationLock critical section — the local analogue of
  // the CloudBase runTransaction envelope — sharing the same pure transition
  // functions, so all adapters run one state machine.

  async createDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      if (docs.some((document) => document._id === id)) return 'exists';
      const { _id, ...payload } = data as Record<string, unknown> & { _id?: unknown };
      docs.push({ _id: id, ...payload } as CollectionDoc);
      this.persist();
      return 'created';
    });
  }

  async removeDocIfFieldEquals(
    collection: string,
    id: string,
    field: string,
    expectedValue: unknown,
  ): Promise<boolean> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      const index = docs.findIndex(
        (document) => document._id === id && document[field] === expectedValue,
      );
      if (index < 0) return false;
      docs.splice(index, 1);
      this.persist();
      return true;
    });
  }

  async saveCatalogProductWithIdentities(
    input: CatalogProductSaveInput,
  ): Promise<CatalogProductSaveResult> {
    return this.withMutationLock(() => {
      const products = this.docs('products');
      const productIndex = products.findIndex((document) => document._id === input.productId);
      const existing = productIndex >= 0 ? (products[productIndex] as CollectionDoc) : null;
      const plan = planCatalogProductSave(existing, input, new Date().toISOString());
      if (plan.result !== 'ready') return plan;

      const identityDocs = this.docs('catalogProductIdentities');
      for (const identity of plan.identities) {
        const existingIdentity = identityDocs.find((document) => document._id === identity.id);
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
        if (!identityDocs.some((document) => document._id === identity.id)) {
          identityDocs.push({
            _id: identity.id,
            kind: identity.kind,
            normalizedValue: identity.normalizedValue,
            productId: input.productId,
            createdAt: plan.doc.updatedAt,
            updatedAt: plan.doc.updatedAt,
          } as CollectionDoc);
        }
      }
      if (productIndex >= 0) products[productIndex] = plan.doc;
      else products.push(plan.doc);
      for (const identity of plan.staleIdentities) {
        const index = identityDocs.findIndex(
          (document) => document._id === identity.id && document.productId === input.productId,
        );
        if (index >= 0) identityDocs.splice(index, 1);
      }
      this.persist();
      return { result: 'saved', doc: plan.doc, previous: existing };
    });
  }

  async upsertDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    createOnly: Record<string, unknown> = {},
  ): Promise<CollectionDoc> {
    return this.withMutationLock(() => {
      const docs = this.docs(collection);
      const index = docs.findIndex((document) => document._id === id);
      const now = new Date().toISOString();
      const { _id, ...patch } = data as Record<string, unknown> & { _id?: unknown };
      if (index >= 0) {
        const next = { ...(docs[index] as CollectionDoc), ...patch, updatedAt: now };
        docs[index] = next;
        this.persist();
        return next;
      }
      const { _id: _createId, ...safeCreateOnly } = createOnly as Record<string, unknown> & {
        _id?: unknown;
      };
      const created = {
        _id: id,
        createdAt: now,
        updatedAt: now,
        ...safeCreateOnly,
        ...patch,
      } as CollectionDoc;
      docs.push(created);
      this.persist();
      return created;
    });
  }

  async upsertCatalogSourceObservation(
    id: string,
    data: Record<string, unknown>,
    createOnly: Record<string, unknown>,
  ): Promise<CatalogSourceObservationUpsertResult> {
    return this.withMutationLock(() => {
      const docs = this.docs('catalogSourceObservations');
      const index = docs.findIndex((document) => document._id === id);
      const now = new Date().toISOString();
      const { _id: _patchId, ...patch } = data as Record<string, unknown> & { _id?: unknown };
      if (index >= 0) {
        const existing = docs[index] as CollectionDoc;
        const previousAt = Date.parse(String(existing.observedAt ?? ''));
        const incomingAt = Date.parse(String(patch.observedAt ?? ''));
        if (Number.isFinite(previousAt) && previousAt > incomingAt) {
          return { result: 'stale', doc: existing };
        }
        const next = { ...existing, ...patch, updatedAt: now };
        docs[index] = next;
        this.persist();
        return { result: 'applied', doc: next };
      }
      const { _id: _createId, ...safeCreateOnly } = createOnly as Record<string, unknown> & {
        _id?: unknown;
      };
      const created = {
        _id: id,
        createdAt: now,
        updatedAt: now,
        ...safeCreateOnly,
        ...patch,
      } as CollectionDoc;
      docs.push(created);
      this.persist();
      return { result: 'applied', doc: created };
    });
  }

  async acquireAlibabaSyncLease(
    connectionId: string,
    holder: string,
    now: string,
    ttlMs: number,
  ): Promise<AlibabaLeaseGrant> {
    return this.withMutationLock(() => {
      const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
      const index = docs.findIndex((document) => document._id === connectionId);
      const existing = index >= 0 ? (docs[index] as CollectionDoc) : null;
      const transition = transitionAlibabaLeaseAcquire(existing, holder, now, ttlMs);
      if (transition.result !== 'granted') return { result: transition.result };
      const next = { _id: connectionId, ...transition.doc, updatedAt: now } as CollectionDoc;
      if (index >= 0) docs[index] = next;
      else docs.push(next);
      this.persist();
      return { result: 'granted', fence: transition.fence };
    });
  }

  async renewAlibabaSyncLease(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.withMutationLock(() => {
      const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
      const index = docs.findIndex((document) => document._id === connectionId);
      const existing = index >= 0 ? (docs[index] as CollectionDoc) : null;
      const transition = transitionAlibabaLeaseRenew(existing, holder, fence, now, ttlMs);
      if (transition.result !== 'applied') return false;
      docs[index] = { ...(existing as CollectionDoc), ...transition.patch, updatedAt: now };
      this.persist();
      return true;
    });
  }

  async releaseAlibabaSyncLease(
    connectionId: string,
    holder: string,
    fence: number,
    now: string,
  ): Promise<boolean> {
    return this.withMutationLock(() => {
      const docs = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
      const index = docs.findIndex((document) => document._id === connectionId);
      const existing = index >= 0 ? (docs[index] as CollectionDoc) : null;
      const transition = transitionAlibabaLeaseRelease(existing, holder, fence, now);
      if (transition.result !== 'applied') return false;
      if (Object.keys(transition.patch).length > 0) {
        docs[index] = { ...(existing as CollectionDoc), ...transition.patch, updatedAt: now };
        this.persist();
      }
      return true;
    });
  }

  async updateDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean> {
    return this.withMutationLock(() => {
      // Lease recheck + target write in ONE critical section (R1 E2).
      const leases = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
      const lease = leases.find((document) => document._id === guard.connectionId) ?? null;
      if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
      const docs = this.docs(collection);
      const index = docs.findIndex((document) => document._id === id);
      if (index < 0) return false;
      docs[index] = { ...(docs[index] as CollectionDoc), ...patch, updatedAt: guard.now };
      this.persist();
      return true;
    });
  }

  async upsertDocWithAlibabaLease(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    createOnly: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean> {
    return this.withMutationLock(() => {
      const leases = this.docs(ALIBABA_SYNC_LEASE_COLLECTION);
      const lease = leases.find((document) => document._id === guard.connectionId) ?? null;
      if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return false;
      const docs = this.docs(collection);
      const index = docs.findIndex((document) => document._id === id);
      const { _id: _patchId, ...safePatch } = patch as Record<string, unknown> & { _id?: unknown };
      if (index >= 0) {
        docs[index] = {
          ...(docs[index] as CollectionDoc),
          ...safePatch,
          updatedAt: guard.now,
        };
      } else {
        const { _id: _createId, ...safeCreateOnly } = createOnly as Record<string, unknown> & {
          _id?: unknown;
        };
        docs.push({
          _id: id,
          ...safeCreateOnly,
          ...safePatch,
          createdAt: guard.now,
          updatedAt: guard.now,
        } as CollectionDoc);
      }
      this.persist();
      return true;
    });
  }

  async claimAlibabaSyncRun(
    runId: string,
    run: Record<string, unknown>,
    checkpointPatch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<AlibabaSyncRunClaimResult> {
    return this.withMutationLock(() => {
      const lease =
        this.docs(ALIBABA_SYNC_LEASE_COLLECTION).find(
          (document) => document._id === guard.connectionId,
        ) ?? null;
      if (!holdsAlibabaLease(lease, guard.holder, guard.fence, guard.now)) return 'lease-lost';

      const checkpoints = this.docs('alibabaSyncCheckpoints');
      const checkpointIndex = checkpoints.findIndex(
        (document) => document._id === guard.connectionId,
      );
      if (checkpointIndex < 0) return 'checkpoint-missing';
      const checkpoint = checkpoints[checkpointIndex] as CollectionDoc;
      if (checkpoint.activeRunId !== undefined && checkpoint.activeRunId !== '') {
        return 'checkpoint-busy';
      }

      const runs = this.docs('alibabaSyncRuns');
      if (runs.some((document) => document._id === runId)) return 'run-exists';

      const { _id: _runId, ...safeRun } = run as Record<string, unknown> & { _id?: unknown };
      const { _id: _checkpointId, ...safeCheckpointPatch } = checkpointPatch as Record<
        string,
        unknown
      > & { _id?: unknown };
      runs.push({
        _id: runId,
        ...safeRun,
        createdAt: guard.now,
        updatedAt: guard.now,
      } as CollectionDoc);
      checkpoints[checkpointIndex] = {
        ...checkpoint,
        ...safeCheckpointPatch,
        updatedAt: guard.now,
      } as CollectionDoc;
      this.persist();
      return 'claimed';
    });
  }

  /** Seed a collection only when it is currently empty. */
  async ensureCatalogProductIdentityReservations(): Promise<void> {
    await this.withMutationLock(() => {
      const expected = new Map<
        string,
        { kind: 'slug' | 'sku'; normalizedValue: string; productId: string }
      >();
      for (const product of this.docs('products')) {
        const identities = [
          ['slug', normalizeProductSlug(product.slug)],
          ['sku', normalizeSkuCode(product.skuCode)],
        ] as const;
        for (const [kind, normalizedValue] of identities) {
          if (normalizedValue === null) continue;
          const id = `${kind}:${normalizedValue}`;
          const candidate = { kind, normalizedValue, productId: product._id };
          const duplicate = expected.get(id);
          if (duplicate && duplicate.productId !== product._id) {
            throw new Error(`Local product identity ${id} is claimed by multiple products.`);
          }
          expected.set(id, candidate);
        }
      }

      const reservations = this.docs('catalogProductIdentities');
      const missing: CollectionDoc[] = [];
      for (const [id, identity] of expected) {
        const existing = reservations.find((document) => document._id === id);
        if (!existing) {
          missing.push({ _id: id, ...identity });
          continue;
        }
        if (
          existing.productId !== identity.productId ||
          existing.kind !== identity.kind ||
          existing.normalizedValue !== identity.normalizedValue
        ) {
          throw new Error(`Local product identity ${id} has conflicting reservation data.`);
        }
      }
      if (missing.length === 0) return;
      const now = new Date().toISOString();
      reservations.push(
        ...missing.map((identity) => ({ ...identity, createdAt: now, updatedAt: now })),
      );
      this.persist();
    });
  }

  /** Seed a collection only when it is currently empty. */
  seedIfEmpty(collection: string, rows: Record<string, unknown>[]): void {
    // Startup-only API: seed.ts invokes this synchronously before the server
    // accepts requests. Reload first so another adapter instance cannot be
    // overwritten by a stale constructor snapshot.
    this.store = this.load();
    if (this.docs(collection).length > 0) return;
    const now = new Date().toISOString();
    for (const row of rows) {
      this.docs(collection).push({ _id: randomUUID(), ...row, createdAt: now, updatedAt: now });
    }
    this.persist();
  }
}

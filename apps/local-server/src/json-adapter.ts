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
  type AdapterListQuery,
  type DbAdapter,
  type ImageMutationAcquireResult,
  type ImageMutationReleaseResult,
  nextCounterValue,
  transitionImageMutationAcquire,
  transitionImageMutationRelease,
} from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  getCollection,
  matchesFilter,
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

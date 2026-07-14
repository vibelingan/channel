/**
 * File-backed implementation of `DbAdapter` for local development.
 *
 * Persists every collection to a single JSON file so edits made through the
 * admin UI survive restarts — a lightweight stand-in for the remote CloudBase
 * database. Concurrency is naive (read-modify-write) which is fine for a single
 * local developer.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type AdapterListQuery, type DbAdapter, nextCounterValue } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  getCollection,
  matchesFilter,
} from '@vibelingan-channel/shared';

type Store = Record<string, CollectionDoc[]>;

export class JsonFileAdapter implements DbAdapter {
  private store: Store;

  constructor(private readonly file: string) {
    this.store = this.load();
  }

  private load(): Store {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Store;
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.store, null, 2), 'utf8');
  }

  private docs(collection: string): CollectionDoc[] {
    if (!this.store[collection]) this.store[collection] = [];
    return this.store[collection];
  }

  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
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
  }

  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d._id === id) ?? null;
  }

  async findByField(
    collection: string,
    field: string,
    value: unknown,
  ): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d[field] === value) ?? null;
  }

  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const now = new Date().toISOString();
    const doc: CollectionDoc = { _id: randomUUID(), ...data, createdAt: now, updatedAt: now };
    this.docs(collection).push(doc);
    this.persist();
    return doc;
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index === -1) return null;
    const existing = docs[index] as CollectionDoc;
    const updated: CollectionDoc = { ...existing, ...data, updatedAt: new Date().toISOString() };
    docs[index] = updated;
    this.persist();
    return updated;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index === -1) return false;
    docs.splice(index, 1);
    this.persist();
    return true;
  }

  async incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index === -1) return null;
    const existing = docs[index] as CollectionDoc;
    const next = nextCounterValue(existing[field], delta);
    docs[index] = { ...existing, [field]: next, updatedAt: new Date().toISOString() };
    this.persist();
    return next;
  }

  /** Seed a collection only when it is currently empty. */
  seedIfEmpty(collection: string, rows: Record<string, unknown>[]): void {
    if (this.docs(collection).length > 0) return;
    const now = new Date().toISOString();
    for (const row of rows) {
      this.docs(collection).push({ _id: randomUUID(), ...row, createdAt: now, updatedAt: now });
    }
    this.persist();
  }
}

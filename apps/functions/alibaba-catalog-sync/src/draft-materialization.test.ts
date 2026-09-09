import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { materializeAlibabaDraftPage } from './draft-materialization.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  constructor(readonly store: Store) {}
  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...this.docs(query.collection)];
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    if (query.sort) docs.sort((a, b) => compareBySort(a, b, query.sort ?? []));
    const start = (query.page - 1) * query.pageSize;
    return {
      items: docs.slice(start, start + query.pageSize),
      total: docs.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((doc) => doc._id === id) ?? null;
  }
  async findByField(): Promise<CollectionDoc | null> {
    return null;
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((doc) => doc._id === id);
    if (index < 0) return null;
    docs[index] = { ...(docs[index] as CollectionDoc), ...data };
    return docs[index] as CollectionDoc;
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
  async createDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'> {
    const docs = this.docs(collection);
    if (docs.some((doc) => doc._id === id)) return 'exists';
    docs.push({ _id: id, ...data } as CollectionDoc);
    return 'created';
  }
  async upsertDocWithId(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
}

function source(id: string, category = 'cat-a', active = true): CollectionDoc {
  return {
    _id: `source-${id}`,
    sourceProductId: id,
    sourceTitle: `Product ${id}`,
    sourceCategoryId: category,
    active,
  } as CollectionDoc;
}

test('materializes active sources in stable cursor pages and is idempotent', async () => {
  const store: Store = {
    alibabaSourceProducts: [source('3'), source('1'), source('2'), source('gone', 'cat-a', false)],
  };
  setAdapter(new MemoryAdapter(store));

  const first = await materializeAlibabaDraftPage({
    limit: 2,
    now: () => '2026-09-04T08:00:00.000Z',
  });
  assert.deepEqual(first, {
    afterSourceKey: '',
    nextSourceKey: 'source-2',
    done: false,
    visited: 2,
    created: 2,
    existing: 0,
    failures: [],
  });
  const second = await materializeAlibabaDraftPage({
    afterSourceKey: first.nextSourceKey,
    limit: 2,
    now: () => '2026-09-04T08:01:00.000Z',
  });
  assert.equal(second.done, true);
  assert.equal(second.created, 1);
  assert.equal(store.products?.length, 3);
  assert.equal(store.alibabaProductLinks?.length, 3);
  assert.ok(store.products?.every((product) => product.published === false));

  const again = await materializeAlibabaDraftPage({ limit: 2 });
  assert.equal(again.created, 0);
  assert.equal(again.existing, 2);
  assert.equal(store.products?.length, 3);
});

test('can materialize one source category without inventing Channel taxonomy', async () => {
  const store: Store = { alibabaSourceProducts: [source('a', 'cat-a'), source('b', 'cat-b')] };
  setAdapter(new MemoryAdapter(store));
  const page = await materializeAlibabaDraftPage({ sourceCategoryId: 'cat-b' });
  assert.equal(page.visited, 1);
  assert.equal(page.created, 1);
  assert.equal(store.products?.[0]?.alibabaSourceProductId, 'b');
  assert.equal(store.products?.[0]?.productFamily, undefined);
});

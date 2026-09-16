import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type AlibabaProductMutationInput,
  type AlibabaProductMutationResult,
  runAlibabaProductMutation,
} from '@vibelingan-channel/db/adapter';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { materializeAlibabaDraftPage } from './draft-materialization.ts';
import { createDraftForSource, draftProductId } from './linking.ts';

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private mutationQueue = Promise.resolve();
  constructor(readonly store: Store) {}
  async mutateAlibabaProduct(
    input: AlibabaProductMutationInput,
  ): Promise<AlibabaProductMutationResult> {
    const operation = this.mutationQueue.then(async () => {
      const copy = structuredClone(this.store);
      const result = await runAlibabaProductMutation(
        {
          get: async (collection, id) =>
            structuredClone(copy[collection]?.find((row) => row._id === id) ?? null),
          set: async (collection, row) => {
            copy[collection] ??= [];
            const rows = copy[collection];
            const index = rows.findIndex((existing) => existing._id === row._id);
            if (index < 0) rows.push(structuredClone(row));
            else rows[index] = structuredClone(row);
          },
          remove: async (collection, id) => {
            copy[collection] = (copy[collection] ?? []).filter((row) => row._id !== id);
          },
        },
        (copy.alibabaProductLinks ?? []).filter((row) => row.productId === input.productId),
        input,
      );
      if (result.ok) Object.assign(this.store, copy);
      return result;
    });
    this.mutationQueue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
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
    connectionId: 'primary',
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

test('propagates identity conflicts without changing products or links', async () => {
  const store: Store = {
    alibabaSourceProducts: [source('conflict')],
    products: [
      {
        _id: draftProductId('source-conflict'),
        alibabaLinkRevision: -1,
        published: false,
      },
    ],
    alibabaProductLinks: [],
  };
  const before = structuredClone(store);
  setAdapter(new MemoryAdapter(store));
  const conflict = await createDraftForSource('source-conflict', {
    now: '2026-09-15T10:00:00.000Z',
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok) assert.fail('expected the conflicting draft identity to be rejected');

  const page = await materializeAlibabaDraftPage({ limit: 2 });

  assert.deepEqual(page, {
    afterSourceKey: '',
    nextSourceKey: 'source-conflict',
    done: true,
    visited: 1,
    created: 0,
    existing: 0,
    failures: [{ sourceKey: 'source-conflict', reason: conflict.reason }],
  });
  assert.deepEqual(store.products, before.products);
  assert.deepEqual(store.alibabaProductLinks, before.alibabaProductLinks);
});

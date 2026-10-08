/** Admin prepare: manual products take the manual path (MIU-30). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { type AdapterListQuery, type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import type { ApprovalPersistenceCommand } from '@vibelingan-channel/db/catalog-detail-staging';
import { type CollectionDoc, type ListResult, matchesFilter } from '@vibelingan-channel/shared';
import { prepareCatalogSource } from './catalog-detail-source.ts';

class RecordingAdapter implements DbAdapter {
  commands: ApprovalPersistenceCommand[] = [];
  constructor(private readonly store: Record<string, CollectionDoc[]>) {}
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    const filter = query.filter;
    const docs = (this.store[query.collection] ?? []).filter(
      (doc) => !filter || matchesFilter(doc, filter),
    );
    return {
      items: docs.slice(0, query.pageSize),
      total: docs.length,
      page: 1,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string) {
    return (this.store[collection] ?? []).find((doc) => doc._id === id) ?? null;
  }
  async persistCatalogDetailApproval(_actorId: string, input: ApprovalPersistenceCommand) {
    this.commands.push(input);
    return { ok: true as const, jobId: 'j', revision: 'r', nextPage: 1, pages: 1, complete: true };
  }
  async findByField(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async create(): Promise<CollectionDoc> {
    throw new Error('not used');
  }
  async update(): Promise<CollectionDoc | null> {
    throw new Error('not used');
  }
  async remove(): Promise<boolean> {
    throw new Error('not used');
  }
  async incrementField(): Promise<number | null> {
    throw new Error('not used');
  }
}

test('a manual product prepares through the manual command, once', async () => {
  const adapter = new RecordingAdapter({ products: [{ _id: 'm1', name: 'Kids headset' }] });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' });
  assert.deepEqual(result, {
    ok: true,
    jobId: 'j',
    revision: 'r',
    nextPage: 1,
    pages: 1,
    complete: true,
  });
  assert.deepEqual(adapter.commands, [
    { action: 'manual-source', productId: 'm1', configurationRowIds: [] },
  ]);
});

test('a manual product with configuration rows is refused before any write', async () => {
  const adapter = new RecordingAdapter({
    products: [{ _id: 'm1', name: 'Kids headset' }],
    productVariants: [
      { _id: 'row-1', productId: 'm1' },
      { _id: 'row-old', productId: 'm1', archived: true },
      { _id: 'other', productId: 'm2' },
    ],
  });
  setAdapter(adapter);
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' }), {
    ok: false,
    code: 'MANUAL_CONFIGURATIONS',
  });
  assert.deepEqual(adapter.commands, []);
});

test('a linked product keeps the Alibaba prepare path', async () => {
  const adapter = new RecordingAdapter({
    products: [{ _id: 'p1', name: 'Synced', alibabaPrimarySourceKey: 'source-a' }],
  });
  setAdapter(adapter);
  // No stored observation: the Alibaba path answers SOURCE_NOT_READY, as before.
  assert.deepEqual(await prepareCatalogSource('admin', { action: 'prepare', productId: 'p1' }), {
    ok: false,
    code: 'SOURCE_NOT_READY',
  });
  assert.deepEqual(adapter.commands, []);
});

test('leftover rows from an earlier Alibaba link do not block a manual approval', async () => {
  // Unlinking keeps the Alibaba-owned configuration rows; they are not manual
  // configurations, so approving without them drops nothing the admin owns.
  const adapter = new RecordingAdapter({
    products: [{ _id: 'm1', name: 'Was synced' }],
    productVariants: [{ _id: 'v1', productId: 'm1', detailSourceOwner: 'alibaba:source-a' }],
  });
  setAdapter(adapter);
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: 'm1' });
  assert.equal(result.ok, true);
  assert.equal(adapter.commands.length, 1);
});

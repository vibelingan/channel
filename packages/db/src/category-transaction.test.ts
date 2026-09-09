import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { previewCategory, runCategoryCommand } from './category-transaction.ts';

function fixture() {
  const product: CollectionDoc = {
    _id: 'clock',
    name: 'Clock',
    published: false,
    alibabaPrimarySourceKey: 'source',
    alibabaSourceCategoryId: '152801',
  };
  const state = {
    users: { admin: { _id: 'admin', role: 'admin' }, guest: { _id: 'guest', role: 'contributor' } },
    products: { clock: product },
    sourceCategoryMappings: {} as Record<string, CollectionDoc>,
    alibabaSourceProducts: { source: { _id: 'source', sourceCategoryId: '152801', active: true } },
    alibabaProductLinks: { source: { _id: 'source', productId: 'clock' } } as Record<
      string,
      CollectionDoc
    >,
  };
  const buckets: Record<string, Record<string, CollectionDoc>> = state;
  const tx = {
    get: async (c: string, id: string) => buckets[c]?.[id] ?? null,
    set: async (c: string, row: CollectionDoc) => {
      buckets[c] ??= {};
      const bucket = buckets[c];
      bucket[row._id] = row;
    },
  };
  return { state, product, tx };
}
const now = '2026-09-08T00:00:00.000Z';
const op = '12345678-1234-4234-8234-123456789012';

test('configure and apply persist only classification, with safe idempotent retry', async () => {
  const f = fixture();
  assert.equal(
    (
      await runCategoryCommand(
        f.tx,
        'admin',
        { kind: 'configure', sourceCategoryId: '152801' },
        now,
      )
    ).status,
    'configured',
  );
  const rule = f.state.sourceCategoryMappings['alibaba-icbu-152801'];
  const preview = previewCategory(f.product, rule, now);
  assert.equal(preview.status, 'ready');
  assert.ok(preview.command);
  const command = { ...preview.command, operationId: op };
  assert.equal((await runCategoryCommand(f.tx, 'admin', command, now)).status, 'applied');
  assert.equal(f.state.products.clock.productFamily, 'misc');
  assert.equal(f.state.products.clock.published, false);
  assert.equal(f.state.products.clock.name, 'Clock');
  assert.equal((await runCategoryCommand(f.tx, 'admin', command, now)).status, 'replayed');
});

test('concurrent manual edit, source move, deleted link, stale rule and expiry reject writes', async () => {
  for (const change of ['manual', 'source', 'rule', 'link', 'expired']) {
    const f = fixture();
    await runCategoryCommand(f.tx, 'admin', { kind: 'configure', sourceCategoryId: '152801' }, now);
    const preview = previewCategory(
      f.product,
      f.state.sourceCategoryMappings['alibaba-icbu-152801'],
      now,
    );
    assert.equal(preview.status, 'ready');
    if (change === 'manual') f.product.productFamily = 'toys';
    if (change === 'source') f.state.alibabaSourceProducts.source.sourceCategoryId = '518';
    if (change === 'rule') {
      const rule = f.state.sourceCategoryMappings['alibaba-icbu-152801'];
      assert.ok(rule);
      rule.productFamily = 'toys';
    }
    if (change === 'link') Reflect.deleteProperty(f.state.alibabaProductLinks, 'source');
    const before = structuredClone(f.state.products);
    const result = await runCategoryCommand(
      f.tx,
      'admin',
      { ...preview.command, operationId: op },
      change === 'expired' ? '2026-09-08T02:00:00.000Z' : now,
    );
    assert.equal(result.status, 'conflict', change);
    assert.deepEqual(f.state.products, before);
  }
});

test('authorization, unknown rule, malformed command and published products fail closed', async () => {
  const f = fixture();
  assert.equal(
    (
      await runCategoryCommand(
        f.tx,
        'guest',
        { kind: 'configure', sourceCategoryId: '152801' },
        now,
      )
    ).status,
    'forbidden',
  );
  assert.equal(
    (
      await runCategoryCommand(
        f.tx,
        'admin',
        { kind: 'configure', sourceCategoryId: '100007155' },
        now,
      )
    ).status,
    'invalid',
  );
  assert.equal((await runCategoryCommand(f.tx, 'admin', null, now)).status, 'invalid');
  assert.equal(previewCategory({ ...f.product, published: true }, null, now).status, 'protected');
  assert.equal(
    previewCategory({ ...f.product, productFamily: 'toys' }, null, now).status,
    'protected',
  );
});

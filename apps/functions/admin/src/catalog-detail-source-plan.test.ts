import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import { SourcePageSchema } from '@vibelingan-channel/db/catalog-source-staging';
import { prepareCatalogSource, readAlibabaDetailPlan } from './catalog-detail-source.ts';
import { CatalogValidationSchema } from './catalog-validation.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';

for (const count of [0, 1, 20, 21, 105]) {
  test(`read source plan for ${count} configurations does not stage or change stored data`, async () => {
    const { product, adapter } = fixture(count);
    const before = structuredClone(adapter.rows);
    const read = await readAlibabaDetailPlan(product._id, product, 0, 50);
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.detail.name, product.name);
    assert.equal(read.detail.descriptionText, product.description);
    assert.equal(read.detail.variants.total, count);
    assert.equal(read.detail.variants.items.length, Math.min(count, 50));
    assert.equal(read.detail.variants.pageSize, 50);
    assert.equal(read.packet.header.name, 'Supplier title');
    assert.equal(read.packet.variantIds.length, count);
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(adapter.rows, before);
    const stagedSize = await readAlibabaDetailPlan(product._id, product, 0, 20);
    assert.ok(stagedSize.ok);
    assert.equal(
      stagedSize.packet.revision,
      read.packet.revision,
      'read page size does not change source input identity',
    );
    const packet = SourcePageSchema.parse(stagedSize.packet);
    assert.equal(
      (await prepareCatalogSource('admin', { action: 'prepare', productId: product._id })).ok,
      true,
    );
    assert.deepEqual(
      adapter.commands,
      [packet],
      'only explicit preparation invokes persistence, exactly once',
    );
    assert.deepEqual(adapter.rows, before);
  });
}

test('source read plan still refuses a missing real mirror without a fallback or write', async () => {
  const { product, adapter } = fixture(1);
  adapter.rows.alibabaSourceProducts = [];
  const before = structuredClone(adapter.rows);
  assert.deepEqual(await readAlibabaDetailPlan(product._id, product, 0, 50), {
    ok: false,
    code: 'SOURCE_NOT_READY',
  });
  assert.deepEqual(adapter.commands, []);
  assert.deepEqual(adapter.rows, before);
});

test('source read plan validates a bad later configuration before any staging', async () => {
  const { product, adapter } = fixture(105);
  const stored = adapter.rows.catalogSourceObservations?.[0];
  assert.ok(stored);
  const checked = validateCatalogSourceObservation(stored.observation);
  assert.ok(checked.ok);
  stored.observation = checked.value;
  const later = checked.value.variants[104];
  assert.ok(later);
  later.sku = 'x'.repeat(201);
  const before = structuredClone(adapter.rows);
  const result = await readAlibabaDetailPlan(product._id, product, 0, 50);
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
  const report = CatalogValidationSchema.parse(result.validation);
  assert.equal(report.issues[0]?.path, 'variants.items.104.sku');
  assert.deepEqual(adapter.commands, []);
  assert.deepEqual(adapter.rows, before);
});

test('manual prepare must not drop configurations beyond the supported scan', async () => {
  const { product, adapter } = fixture(0);
  product.alibabaPrimarySourceKey = '';
  adapter.list = async () => ({
    items: [{ _id: 'old', detailSourceOwner: 'alibaba:old' }],
    total: 10001,
    page: 1,
    pageSize: 100,
  });
  const result = await prepareCatalogSource('admin', { action: 'prepare', productId: product._id });
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result));
  assert.deepEqual(adapter.commands, []);
});

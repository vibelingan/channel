import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompleteCatalogPreparationPlan } from '@vibelingan-channel/catalog-import/detail-candidate';
import {
  sourceMediaLinkId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import/observations';
import { SourcePageSchema } from '@vibelingan-channel/db/catalog-source-staging';
import { CATALOG_DETAIL_VARIANT_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  prepareCatalogSource,
  readAlibabaDetailPlan,
  sourceVariantIds,
} from './catalog-detail-source.ts';
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

test('malformed saved configuration choices must not silently erase valid choices or stage source data', async () => {
  const { product, observation, adapter } = fixture(105);
  const first = sourceVariantIds(product._id, String(product.alibabaPrimarySourceKey), observation)
    .values()
    .next().value;
  assert.ok(first);
  product.imageIds = ['img-chosen'];
  product.configurationPhotos = {
    [first]: ['img-chosen'],
    'private-configuration-key': ['private-invalid-image/value'],
  };
  const before = structuredClone(adapter.rows);
  for (const read of [
    () => readAlibabaDetailPlan(product._id, product, 0, 50),
    () => prepareCatalogSource('admin', { action: 'prepare', productId: product._id }),
  ]) {
    const result = await read();
    assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
    const report = CatalogValidationSchema.parse(result.validation);
    assert.equal(report.issues[0]?.path, 'configurationPhotos.field.0');
    assert.equal(report.issues[0]?.remedy, 'edit');
    assert.doesNotMatch(JSON.stringify(report), /private-/);
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(adapter.rows, before);
  }
});

test('configuration photo choices cannot push a later configuration beyond the effective byte budget unnoticed', async () => {
  const { product, observation, adapter } = fixture(105);
  const last = observation.variants.at(-1);
  assert.ok(last);
  const padding = { sourceName: 'Padding', value: '界' };
  last.options = [
    ...Array.from({ length: 21 }, (_, index) => ({
      sourceName: `Field ${index}`,
      value: '界'.repeat(2000),
    })),
    padding,
  ];
  product.imageIds = Array.from({ length: 9 }, (_, index) => `img${index}_${'x'.repeat(190)}`);
  const ids = sourceVariantIds(product._id, String(product.alibabaPrimarySourceKey), observation);
  const lastId = ids.get(last.sourceVariantKey);
  assert.ok(lastId);
  const bindings = {
    productId: product._id,
    variants: ids,
    images: new Map<string, string>(),
    websiteProduct: { ...product, detailSourceOwner: 'alibaba:read-source' },
  };
  let low = 1;
  let high = 2000;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    padding.value = '界'.repeat(middle);
    const plan = buildCompleteCatalogPreparationPlan(observation, bindings);
    if (plan.ok) {
      best = middle;
      low = middle + 1;
    } else {
      assert.equal(plan.issues[0]?.code, 'TOO_LARGE');
      high = middle - 1;
    }
  }
  assert.ok(best > 0);
  padding.value = '界'.repeat(best);
  const beforeChoice = buildCompleteCatalogPreparationPlan(observation, bindings);
  assert.ok(beforeChoice.ok);
  const variant = beforeChoice.value.variants.at(-1);
  assert.ok(variant);
  const bytes = Buffer.byteLength(JSON.stringify(variant));
  assert.ok(
    bytes <= CATALOG_DETAIL_VARIANT_MAX_BYTES && bytes > CATALOG_DETAIL_VARIANT_MAX_BYTES - 3,
  );
  product.configurationPhotos = { [lastId]: product.imageIds };
  const stored = adapter.rows.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation;
  const before = structuredClone(adapter.rows);
  const read = await readAlibabaDetailPlan(product._id, product, 0, 50);
  assert.ok(!read.ok && read.code === 'VALIDATION_ERROR');
  const report = CatalogValidationSchema.parse(read.validation);
  assert.equal(report.issues[0]?.path, 'variants.items.104');
  assert.equal(report.issues[0]?.remedy, 'edit');
  assert.equal(report.issues[0]?.expected?.maxBytes, CATALOG_DETAIL_VARIANT_MAX_BYTES);
  assert.ok((report.issues[0]?.observed?.bytes ?? 0) > CATALOG_DETAIL_VARIANT_MAX_BYTES);
  assert.deepEqual(
    await prepareCatalogSource('admin', { action: 'prepare', productId: product._id }),
    read,
  );
  assert.deepEqual(adapter.commands, []);
  assert.deepEqual(adapter.rows, before);
});

for (const [sourceUrl, copiedUrl] of [
  ['http://sc04.alicdn.com/photo.jpg', 'https://sc04.alicdn.com/photo.jpg'],
  ['http://sc04.alicdn.com:81/retained.jpg', 'https://sc04.alicdn.com:81/retained.jpg'],
  ['http://s.alibaba.com/photo.jpg?size=large', 'https://s.alibaba.com/photo.jpg?size=large'],
  ['HTTP://S.ALIBABA.COM/photo.jpg', 'https://s.alibaba.com/photo.jpg'],
  ['https://example.com/retained.jpg', 'https://example.com/retained.jpg'],
] as const) {
  test(`source preparation reuses the exact copied URL binding for ${sourceUrl}`, async () => {
    const { product, adapter } = fixture(1);
    const stored = adapter.rows.catalogSourceObservations?.[0];
    assert.ok(stored);
    const checked = validateCatalogSourceObservation(stored.observation);
    assert.ok(checked.ok);
    const variant = checked.value.variants[0];
    assert.ok(variant);
    variant.media = [{ sourceUrl, position: 0, role: 'variant' }];
    stored.observation = checked.value;
    adapter.rows.catalogSourceLinks = [
      {
        _id: sourceMediaLinkId('alibaba', copiedUrl),
        provider: 'alibaba',
        kind: 'media',
        sourceUrl: copiedUrl,
        imageId: 'copied-photo',
      },
    ];
    const before = structuredClone(adapter.rows);
    const read = await readAlibabaDetailPlan(product._id, product, 0, 50);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.packet.variantMedia[0]?.unboundSources, []);
    assert.deepEqual(read.detail.variants.items[0]?.images, ['/api/images/copied-photo']);
    assert.deepEqual(adapter.commands, []);
    assert.deepEqual(adapter.rows, before);
  });
}

for (const corrupted of [
  { provider: 'other' },
  { sourceUrl: 'https://s.alibaba.com/different.jpg' },
  { imageId: ['copied-photo'] },
]) {
  test(`a copied URL cannot borrow a corrupt binding ${JSON.stringify(corrupted)}`, async () => {
    const { product, adapter } = fixture(1);
    const sourceUrl = 'http://s.alibaba.com/photo.jpg';
    const copiedUrl = 'https://s.alibaba.com/photo.jpg';
    const stored = adapter.rows.catalogSourceObservations?.[0];
    assert.ok(stored);
    const checked = validateCatalogSourceObservation(stored.observation);
    assert.ok(checked.ok);
    const variant = checked.value.variants[0];
    assert.ok(variant);
    variant.media = [{ sourceUrl, position: 0, role: 'variant' }];
    stored.observation = checked.value;
    adapter.rows.catalogSourceLinks = [
      {
        _id: sourceMediaLinkId('alibaba', copiedUrl),
        provider: 'alibaba',
        sourceUrl: copiedUrl,
        imageId: 'copied-photo',
        ...corrupted,
      },
    ];
    const before = structuredClone(adapter.rows);
    const read = await readAlibabaDetailPlan(product._id, product, 0, 50);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.packet.variantMedia[0]?.unboundSources, [sourceUrl]);
    assert.deepEqual(read.detail.variants.items[0]?.images, []);
    assert.deepEqual(adapter.rows, before);
    assert.deepEqual(adapter.commands, []);
  });
}

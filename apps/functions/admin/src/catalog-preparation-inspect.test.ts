import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
import { CatalogPreparationReportSchema } from '@vibelingan-channel/shared/catalog-preparation';
import { sourceVariantIds } from './catalog-detail-source.ts';
import { inspectCatalogPreparation } from './catalog-preparation-inspect.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';

const instant = Date.parse('2026-10-14T11:00:00.000Z');
const options = { now: () => instant };
function sample(count = 105) {
  const h = fixture(count);
  const id = (index: number) => `image-${String(index).padStart(4, '0')}`;
  const url = (index: number) => `https://sc04.alicdn.com/inspection-${index}.png`;
  for (const [index, variant] of h.observation.variants.entries())
    variant.media = [{ sourceUrl: url(index), position: 0, role: 'variant' }];
  const stored = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = h.observation;
  h.adapter.rows.catalogSourceLinks = Array.from({ length: count }, (_, index) => ({
    _id: sourceMediaLinkId('alibaba', url(index)),
    provider: 'alibaba',
    sourceUrl: url(index),
    imageId: id(index),
  }));
  h.adapter.rows.images = Array.from({ length: count }, (_, index) => ({
    _id: id(index),
    status: 'active',
    storageProvider: index % 2 ? 'local-disk' : 'cloudbase-storage',
    publishedRefCount: 0,
  }));
  const inspect = () => inspectCatalogPreparation('admin', { productId: h.product._id }, options);
  return { ...h, inspect, id };
}

test('a complete unclassified candidate checks every configuration image without any command or mutation', async () => {
  const h = sample();
  Reflect.deleteProperty(h.product, 'productFamily');
  const before = structuredClone(h.adapter.rows);
  let active = 0;
  let peak = 0;
  let reads = 0;
  let sourceReads = 0;
  let sourceQueries = 0;
  const list = h.adapter.list.bind(h.adapter);
  h.adapter.list = async (query) => {
    if (query.collection === 'catalogSourceLinks') sourceQueries++;
    return list(query);
  };
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    if (collection === 'catalogSourceLinks') sourceReads++;
    if (collection !== 'images') return get(collection, id);
    reads++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await get(collection, id);
    } finally {
      active--;
    }
  };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.kind, 'unsealed-inspection');
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.media, { scanned: 105, total: 105 });
  assert.equal(reads, 105);
  assert.equal(sourceReads, 0);
  assert.equal(sourceQueries, 2);
  assert.ok(peak > 1 && peak <= 8);
  assert.equal(CatalogPreparationReportSchema.safeParse(result).success, false);
  assert.deepEqual(h.adapter.rows, before);
  assert.deepEqual(h.adapter.commands, []);
});

for (const change of [
  { storageProvider: ['cloudbase-storage'] },
  { storageProvider: 'unknown' },
  { status: 'deleted' },
  { publishedRefCount: '1' },
  { publishedRefCount: -1 },
  { imageMutationOwner: 'broken' },
  { imageMutationOwner: 'old', imageMutationStartedAt: '2026-10-13T11:00:00.000Z' },
])
  test(`a bad final configuration image blocks the whole candidate: ${JSON.stringify(change)}`, async () => {
    const h = sample();
    const image = h.adapter.rows.images?.at(-1);
    assert.ok(image);
    Object.assign(image, change);
    const result = await h.inspect();
    assert.ok(result.ok);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.previewReady, true);
    assert.deepEqual(result.media, { scanned: 105, total: 105 });
    assert.ok(
      result.issues.some((issue) => issue.code === 'MEDIA_NOT_READY' && issue.severity === 'error'),
    );
    for (const issue of result.issues) assert.ok(CatalogIssueSchema.safeParse(issue).success);
    assert.deepEqual(h.adapter.commands, []);
  });

test('an unbound final source photo is preparing, while its content remains inspectable', async () => {
  const h = sample();
  h.adapter.rows.catalogSourceLinks?.pop();
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'preparing');
  assert.equal(result.previewReady, true);
  assert.deepEqual(result.media, { scanned: 104, total: 104 });
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['MEDIA_NOT_READY'],
  );
});

test('the issue cap preserves a late hard failure after fifty transient image locks', async () => {
  const h = sample(60);
  for (const image of h.adapter.rows.images ?? []) {
    image.imageMutationOwner = 'busy';
    image.imageMutationStartedAt = new Date(instant - 1000).toISOString();
  }
  const last = h.adapter.rows.images?.at(-1);
  assert.ok(last);
  Reflect.deleteProperty(last, 'imageMutationOwner');
  Reflect.deleteProperty(last, 'imageMutationStartedAt');
  last.status = 'deleted';
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.issues.length, 50);
  assert.ok(result.issues.some((issue) => issue.severity === 'error'));
});

test('fresh locks are preparing and legacy absent image counts remain compatible', async () => {
  const h = sample(2);
  const [busy, legacy] = h.adapter.rows.images ?? [];
  assert.ok(busy && legacy);
  busy.imageMutationOwner = 'busy';
  busy.imageMutationStartedAt = new Date(instant - 1000).toISOString();
  Reflect.deleteProperty(legacy, 'publishedRefCount');
  const first = await h.inspect();
  assert.ok(first.ok);
  assert.equal(first.outcome, 'preparing');
  assert.deepEqual(
    first.issues.map((issue) => issue.code),
    ['MEDIA_BUSY'],
  );
  Reflect.deleteProperty(busy, 'imageMutationOwner');
  Reflect.deleteProperty(busy, 'imageMutationStartedAt');
  const second = await h.inspect();
  assert.ok(second.ok);
  assert.equal(second.outcome, 'ready');
  assert.equal(first.mediaInputDigest, second.mediaInputDigest);
});

test('invalid adopted content in the final configuration is blocked before image checks', async () => {
  const h = sample();
  const variant = h.observation.variants.at(-1);
  assert.ok(variant);
  variant.options[0] = { sourceName: 'Color', value: 'x'.repeat(2001) };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.previewReady, false);
  assert.deepEqual(result.media, { scanned: 0, total: 0 });
  assert.ok(result.issues.some((issue) => issue.code === 'TOO_LONG'));
  assert.equal(JSON.stringify(result).includes('x'.repeat(100)), false);
  assert.deepEqual(h.adapter.commands, []);
});

for (const change of ['product', 'source', 'actor'] as const)
  test(`a ${change} change during media reads prevents reuse of the check`, async () => {
    const h = sample(1);
    const get = h.adapter.get.bind(h.adapter);
    h.adapter.get = async (collection, id) => {
      const result = await get(collection, id);
      if (collection === 'images') {
        if (change === 'product') h.product.description = 'Changed while checking';
        if (change === 'source') {
          const source = h.adapter.rows.alibabaSourceProducts?.[0];
          assert.ok(source);
          source.contentHash = 'f'.repeat(64);
        }
        if (change === 'actor') {
          const actor = h.adapter.rows.users?.[0];
          assert.ok(actor);
          actor.status = 'suspended';
        }
      }
      return result;
    };
    assert.deepEqual(await h.inspect(), {
      ok: false,
      code: change === 'actor' ? 'FORBIDDEN' : 'CONFLICT',
    });
    assert.deepEqual(h.adapter.commands, []);
  });

test('an exhausted soft budget reports incomplete and never claims unchecked images are ready', async () => {
  const h = sample();
  let time = instant;
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    const result = await get(collection, id);
    if (collection === 'images') time += 2;
    return result;
  };
  const result = await inspectCatalogPreparation(
    'admin',
    { productId: h.product._id },
    {
      now: () => time,
      budgetMs: 1,
    },
  );
  assert.ok(result.ok);
  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(result.media, { scanned: 8, total: 105 });
});

test('a manual zero-configuration product is checked through the existing preview without staging', async () => {
  const h = fixture(0);
  Reflect.deleteProperty(h.product, 'alibabaPrimarySourceKey');
  h.adapter.list = async (query) => ({
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
  });
  const result = await inspectCatalogPreparation('admin', { productId: h.product._id }, options);
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(h.adapter.commands, []);
});

test('a missing image record behind a retained source link blocks the complete candidate', async () => {
  const h = sample();
  h.adapter.rows.images?.pop();
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(result.media, { scanned: 105, total: 105 });
});

test('shared source photos are checked once per image, rather than once per configuration', async () => {
  const h = sample();
  for (const link of h.adapter.rows.catalogSourceLinks ?? []) link.imageId = h.id(0);
  h.adapter.rows.images = h.adapter.rows.images?.slice(0, 1) ?? [];
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.media, { scanned: 1, total: 1 });
});

for (const actor of [
  null,
  { _id: 'admin', role: 'contributor' },
  { _id: 'admin', role: 'admin', status: 'suspended' },
])
  test(`an unauthorized checker cannot inspect private inputs: ${JSON.stringify(actor)}`, async () => {
    const h = sample(1);
    h.adapter.rows.users = actor ? [actor] : [];
    assert.deepEqual(await h.inspect(), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(h.adapter.commands, []);
  });

test('invalid identity, absent products and invalid stored generation fail without writes', async () => {
  const h = sample(1);
  assert.deepEqual(
    await inspectCatalogPreparation('admin', { productId: h.product._id, report: {} }, options),
    {
      ok: false,
      code: 'VALIDATION_ERROR',
    },
  );
  assert.deepEqual(await inspectCatalogPreparation('admin', { productId: 'missing' }, options), {
    ok: false,
    code: 'NOT_FOUND',
  });
  h.product.catalogContentGeneration = -1;
  const bad = await h.inspect();
  assert.ok(!bad.ok && bad.code === 'VALIDATION_ERROR' && 'validation' in bad);
  assert.equal(bad.validation.issues[0]?.path, 'catalogContentGeneration');
  assert.deepEqual(h.adapter.commands, []);
});

test('malformed source diagnostics never return rejected supplier values', async () => {
  const h = sample(1);
  const row = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(row);
  row.observation = { privateSupplierValue: 'never-return-this-secret' };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(JSON.stringify(result).includes('never-return-this-secret'), false);
  assert.equal(JSON.stringify(result).includes('privateSupplierValue'), false);
  assert.deepEqual(h.adapter.commands, []);
});

test('replacing the primary link while checking refuses the obsolete inspection', async () => {
  const h = sample(1);
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    const result = await get(collection, id);
    if (collection === 'images') {
      const link = h.adapter.rows.alibabaProductLinks?.[0];
      assert.ok(link);
      link.productId = 'another-product';
    }
    return result;
  };
  assert.deepEqual(await h.inspect(), { ok: false, code: 'CONFLICT' });
});

test('a broken retained publication cannot be called preview-ready even if its new source is valid', async () => {
  const h = sample(1);
  h.product.catalogDetailPublication = { state: 'approved', revision: 'old' };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.previewReady, false);
  assert.ok(result.issues.every((issue) => issue.remedy === 'system-repair'));
  assert.deepEqual(h.adapter.commands, []);
});

test('a retained publication for a different product refuses preview without exposing that identity', async () => {
  const h = sample(1);
  h.product.catalogDetailPublication = {
    state: 'approved',
    revision: 'old',
    variantCount: 0,
    header: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'private-other-product',
      name: 'Other',
      images: [],
      facts: [],
      offers: [],
    },
  };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.previewReady, false);
  assert.equal(JSON.stringify(result).includes('private-other-product'), false);
});

test('a valid source with oversized private preview metadata cannot be called preview-ready', async () => {
  const h = sample(1);
  h.observation.content.media = [
    {
      sourceUrl: `https://sc04.alicdn.com/?${'q'.repeat(2 * 1024 * 1024)}`,
      role: 'primary',
      position: 0,
    },
  ];
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.previewReady, false);
  assert.ok(result.issues.some((issue) => issue.code === 'TOO_LARGE' && issue.stage === 'media'));
  assert.deepEqual(h.adapter.commands, []);
});

test('legitimate shared-image count changes do not invalidate the media content digest', async () => {
  const h = sample(2);
  const before = await h.inspect();
  assert.ok(before.ok && before.outcome === 'ready');
  for (const image of h.adapter.rows.images ?? []) image.publishedRefCount = 20;
  const after = await h.inspect();
  assert.ok(after.ok && after.outcome === 'ready');
  assert.equal(after.mediaInputDigest, before.mediaInputDigest);
  assert.equal(after.inputDigest, before.inputDigest);
  const image = h.adapter.rows.images?.[0];
  assert.ok(image);
  image.storageFileId = 'replaced-owned-object';
  const changed = await h.inspect();
  assert.ok(changed.ok);
  assert.notEqual(changed.mediaInputDigest, before.mediaInputDigest);
});

for (const protocol of ['http:', 'https:'])
  test(`a source photo already known unavailable is blocked with an editing fallback: ${protocol}`, async () => {
    const h = sample();
    h.adapter.rows.catalogSourceLinks?.pop();
    const variant = h.observation.variants.at(-1);
    assert.ok(variant?.media[0]);
    const original = variant.media[0].sourceUrl;
    variant.media[0].sourceUrl = original.replace('https:', protocol);
    h.product.alibabaAutoPhotos = {
      configurations: { sources: [original], imageIds: [], missing: [], unusable: [original] },
    };
    const result = await h.inspect();
    assert.ok(result.ok);
    assert.equal(result.outcome, 'blocked');
    assert.ok(
      result.issues.some(
        (issue) => issue.path === 'configurationPhotos' && issue.remedy === 'edit',
      ),
    );
    assert.equal(JSON.stringify(result).includes(original), false);
    assert.deepEqual(h.adapter.commands, []);
  });

test('a manual owned configuration photo resolves an unavailable supplier photo without changing source data', async () => {
  const h = sample();
  h.adapter.rows.catalogSourceLinks?.pop();
  const variant = h.observation.variants.at(-1);
  assert.ok(variant?.media[0]);
  h.product.alibabaAutoPhotos = { configurations: { unusable: [variant.media[0].sourceUrl] } };
  const id = sourceVariantIds(h.product._id, 'read-source', h.observation).get(
    variant.sourceVariantKey,
  );
  assert.ok(id);
  h.product.imageIds = [h.id(0)];
  h.product.configurationPhotos = { [id]: [h.id(0)] };
  const before = structuredClone(h.adapter.rows);
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.issues, []);
  assert.deepEqual(h.adapter.rows, before);
  assert.deepEqual(h.adapter.commands, []);
});

test('an unbound URL that the existing photo-copy policy cannot import is blocked rather than left waiting', async () => {
  const h = sample(1);
  const variant = h.observation.variants[0];
  assert.ok(variant);
  variant.media = [
    { sourceUrl: 'https://private-other-host.test/supplier.png', role: 'variant', position: 0 },
  ];
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.issues[0]?.remedy, 'edit');
  assert.equal(JSON.stringify(result).includes('private-other-host.test'), false);
});

for (const [name, failed, outcome] of [
  ['gone', { failureReason: 'not-found', failureAttempts: 1 }, 'blocked'],
  ['six failed attempts', { failureReason: 'fetch-failed', failureAttempts: 6 }, 'blocked'],
  ['temporary failure', { failureReason: 'fetch-failed', failureAttempts: 1 }, 'preparing'],
  ['storage failure', { failureReason: 'write-failed', failureAttempts: 0 }, 'preparing'],
  ['invalid failure date', { failureReason: 'not-found', failedAt: 'invalid' }, 'preparing'],
  ['unowned failure record', { failureReason: 'not-found', provider: 'other' }, 'preparing'],
] as const) {
  test(`configuration inspection reads its durable photo failure without a product URL copy: ${name}`, async () => {
    const h = sample(1);
    const link = h.adapter.rows.catalogSourceLinks?.[0];
    assert.ok(link);
    Reflect.deleteProperty(link, 'imageId');
    Object.assign(link, { failedAt: new Date().toISOString(), ...failed });
    const before = structuredClone(h.adapter.rows);
    const result = await h.inspect();
    assert.ok(result.ok);
    assert.equal(result.outcome, outcome);
    assert.equal(result.issues[0]?.remedy, outcome === 'blocked' ? 'edit' : 'retry-media');
    assert.equal(typeof link.sourceUrl, 'string');
    if (typeof link.sourceUrl !== 'string') throw new Error('fixture source URL');
    assert.equal(JSON.stringify(result).includes(link.sourceUrl), false);
    assert.deepEqual(h.adapter.rows, before);
    assert.deepEqual(h.adapter.commands, []);
  });
}

test('a recorded current retry takes precedence over an obsolete product unavailable marker', async () => {
  const h = sample(1);
  const link = h.adapter.rows.catalogSourceLinks?.[0];
  const source = h.observation.variants[0]?.media[0]?.sourceUrl;
  assert.ok(link && source);
  Reflect.deleteProperty(link, 'imageId');
  Object.assign(link, {
    failedAt: new Date().toISOString(),
    failureReason: 'fetch-failed',
    failureAttempts: 1,
  });
  h.product.alibabaAutoPhotos = { configurations: { unusable: [source] } };
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'preparing');
  assert.equal(result.issues[0]?.remedy, 'retry-media');
});

test('a manual owned configuration photo also recovers a durable unavailable link', async () => {
  const h = sample(1);
  const link = h.adapter.rows.catalogSourceLinks?.[0];
  const variant = h.observation.variants[0];
  assert.ok(link && variant);
  Reflect.deleteProperty(link, 'imageId');
  Object.assign(link, {
    failedAt: new Date().toISOString(),
    failureReason: 'not-found',
    failureAttempts: 1,
  });
  const id = sourceVariantIds(h.product._id, 'read-source', h.observation).get(
    variant.sourceVariantKey,
  );
  assert.ok(id);
  h.product.imageIds = [h.id(0)];
  h.product.configurationPhotos = { [id]: [h.id(0)] };
  const before = structuredClone(h.adapter.rows);
  const result = await h.inspect();
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.issues, []);
  assert.deepEqual(h.adapter.rows, before);
});

test('a durable media failure transition changes its inspection digest without changing product inputs', async () => {
  const h = sample(1);
  const link = h.adapter.rows.catalogSourceLinks?.[0];
  assert.ok(link);
  Reflect.deleteProperty(link, 'imageId');
  Object.assign(link, {
    failedAt: new Date().toISOString(),
    failureReason: 'fetch-failed',
    failureAttempts: 1,
  });
  const waiting = await h.inspect();
  assert.ok(waiting.ok && waiting.outcome === 'preparing');
  link.failureAttempts = 6;
  const exhausted = await h.inspect();
  assert.ok(exhausted.ok && exhausted.outcome === 'blocked');
  assert.equal(exhausted.inputDigest, waiting.inputDigest);
  assert.notEqual(exhausted.mediaInputDigest, waiting.mediaInputDigest);
});

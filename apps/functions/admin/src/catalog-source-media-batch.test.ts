import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { readCompleteAlibabaDetailPlan, sourceLinkImageId } from './catalog-detail-source.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';
for (const count of [1, 100, 101, 205])
  test(`source plan resolves ${count} photos in bounded100-ID queries without truncating adopted images`, async () => {
    const h = fixture(count);
    const url = (i: number) => `https://sc04.alicdn.com/batch-${i}.png`;
    for (const [i, v] of h.observation.variants.entries())
      v.media = [{ sourceUrl: url(i), position: 0, role: 'variant' }];
    const observation = h.adapter.rows.catalogSourceObservations?.[0];
    assert.ok(observation);
    observation.observation = h.observation;
    h.adapter.rows.catalogSourceLinks = Array.from({ length: count }, (_, i) => ({
      _id: sourceMediaLinkId('alibaba', url(i)),
      provider: 'alibaba',
      sourceUrl: url(i),
      imageId: `image-${i}`,
    }));
    let queries = 0;
    let points = 0;
    const list = h.adapter.list.bind(h.adapter);
    const get = h.adapter.get.bind(h.adapter);
    h.adapter.list = async (query) => {
      if (query.collection === 'catalogSourceLinks') {
        queries++;
        assert.equal(query.pageSize, 100);
        assert.deepEqual(query.sort, [{ field: '_id', dir: 'asc' }]);
      }
      return list(query);
    };
    h.adapter.get = async (c, id) => {
      if (c === 'catalogSourceLinks') points++;
      return get(c, id);
    };
    const before = structuredClone(h.adapter.rows);
    const plan = await readCompleteAlibabaDetailPlan(h.product._id, h.product);
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(plan.approvalPlan.imageIds.length, count);
    assert.equal(queries, Math.ceil(count / 100));
    assert.equal(points, 0);
    assert.deepEqual(h.adapter.rows, before);
    assert.deepEqual(h.adapter.commands, []);
  });

function onePhoto(url = 'https://sc04.alicdn.com/batch.png') {
  const h = fixture(1);
  const variant = h.observation.variants[0];
  assert.ok(variant);
  variant.media = [{ sourceUrl: url, position: 0, role: 'variant' }];
  const observation = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(observation);
  observation.observation = h.observation;
  const sourceUrl = url.replace(/^http:\/\//, 'https://');
  h.adapter.rows.catalogSourceLinks = [
    {
      _id: sourceMediaLinkId('alibaba', sourceUrl),
      provider: 'alibaba',
      sourceUrl,
      imageId: 'owned-image',
    },
  ];
  return h;
}
for (const change of [
  { provider: 'other' },
  { sourceUrl: 'https://sc04.alicdn.com/other.png' },
  { _id: 'wrong-id' },
])
  test(`batch media never adopts foreign or mismatched binding: ${Object.keys(change)[0]}`, async () => {
    const h = onePhoto();
    const row = h.adapter.rows.catalogSourceLinks?.[0];
    assert.ok(row);
    Object.assign(row, change);
    const plan = await readCompleteAlibabaDetailPlan(h.product._id, h.product);
    assert.ok(plan.ok);
    assert.deepEqual(plan.approvalPlan.imageIds, []);
    assert.equal(plan.packet.variantMedia[0]?.unboundSources.length, 1);
  });
test('legacy HTTP CDN binding is normalized for lookup without a fetch or data rewrite', async () => {
  const h = onePhoto('http://sc04.alicdn.com/batch.png');
  const before = structuredClone(h.adapter.rows);
  const plan = await readCompleteAlibabaDetailPlan(h.product._id, h.product);
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.deepEqual(plan.approvalPlan.imageIds, ['owned-image']);
  assert.deepEqual(h.adapter.rows, before);
  assert.deepEqual(h.adapter.commands, []);
});
test('concurrent count/get disagreement does not discard actually returned valid bindings', async () => {
  const h = onePhoto();
  const list = h.adapter.list.bind(h.adapter);
  h.adapter.list = async (query) => ({ ...(await list(query)), total: 0 });
  const plan = await readCompleteAlibabaDetailPlan(h.product._id, h.product);
  assert.ok(plan.ok);
  assert.deepEqual(plan.approvalPlan.imageIds, ['owned-image']);
});

test('single owned-photo helper remains a point read and rejects a wrong returned identity', async () => {
  const h = onePhoto();
  let gets = 0;
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    if (collection === 'catalogSourceLinks') gets++;
    return get(collection, id);
  };
  h.adapter.list = async () => {
    throw Error('single photo must not query a whole batch');
  };
  assert.equal(await sourceLinkImageId('https://sc04.alicdn.com/batch.png'), 'owned-image');
  assert.equal(gets, 1);
  h.adapter.get = async () => ({
    _id: 'wrong-id',
    provider: 'alibaba',
    sourceUrl: 'https://sc04.alicdn.com/batch.png',
    imageId: 'foreign-image',
  });
  assert.equal(await sourceLinkImageId('https://sc04.alicdn.com/batch.png'), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import { createCatalogMediaState } from './catalog-media.ts';
import { variantMediaSources } from './catalog-variant-media.ts';

test('selection prioritizes only explicitly associated parent images before the shared cap', () => {
  const variant = detailFixture().variants.items[0];
  variant.images = ['/api/images/third'];
  const parents = ['/api/images/first', '/api/images/second', '/api/images/third'];
  const result = createCatalogMediaState(
    variantMediaSources(parents, { status: 'selected', variant }),
  );
  assert.deepEqual(result.sources, [
    '/api/images/third',
    '/api/images/first',
    '/api/images/second',
  ]);
  assert.deepEqual(parents, ['/api/images/first', '/api/images/second', '/api/images/third']);
});

test('missing variant image and pending selection preserve the parent gallery', () => {
  const parents = ['/api/images/first', '/api/images/second'];
  const variant = detailFixture().variants.items[0];
  assert.deepEqual(variantMediaSources(parents, { status: 'selected', variant }), parents);
  assert.deepEqual(
    variantMediaSources(parents, { status: 'pending', requestedId: 'later' }),
    parents,
  );
  variant.images = ['/api/images/not-in-approved-gallery'];
  assert.deepEqual(variantMediaSources(parents, { status: 'selected', variant }), parents);
});

test('preparing gallery sources never changes canonical selection or guesses from image order', () => {
  const variant = detailFixture().variants.items[0];
  variant.images = ['/api/images/second'];
  const selection = { status: 'selected' as const, variant };
  const before = JSON.stringify(selection);
  variantMediaSources(['/api/images/first', '/api/images/second'], selection);
  assert.equal(JSON.stringify(selection), before);
  assert.equal(selection.variant.id, 'variant-1');
});

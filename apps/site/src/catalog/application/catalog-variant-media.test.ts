import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import { createCatalogMediaState } from './catalog-media.ts';
import { variantMediaSources } from './catalog-variant-media.ts';

test('an unmapped selected color must not present a different color from the product gallery', () => {
  const variant = detailFixture().variants.items[0];
  variant.options = [{ name: 'color', value: 'Black' }];
  variant.images = [];
  assert.deepEqual(
    variantMediaSources(['/api/images/white-hero', '/api/images/pink-hero'], {
      status: 'selected',
      variant,
    }),
    [],
  );
});

test('selection shows only explicitly associated photos, independent of the product gallery', () => {
  const variant = detailFixture().variants.items[0];
  variant.images = ['/api/images/third'];
  const parents = ['/api/images/first', '/api/images/second', '/api/images/third'];
  const result = createCatalogMediaState(
    variantMediaSources(parents, { status: 'selected', variant }),
  );
  assert.deepEqual(result.sources, ['/api/images/third']);
  assert.deepEqual(parents, ['/api/images/first', '/api/images/second', '/api/images/third']);
});

test('missing variant image does not borrow product photos; pending selection retains a general gallery', () => {
  const parents = ['/api/images/first', '/api/images/second'];
  const variant = detailFixture().variants.items[0];
  assert.deepEqual(variantMediaSources(parents, { status: 'selected', variant }), []);
  assert.deepEqual(
    variantMediaSources(parents, { status: 'pending', requestedId: 'later' }),
    parents,
  );
  variant.images = ['/api/images/not-in-approved-gallery'];
  assert.deepEqual(variantMediaSources(parents, { status: 'selected', variant }), [
    '/api/images/not-in-approved-gallery',
  ]);
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

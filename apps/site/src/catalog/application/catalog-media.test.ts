import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedGalleryImages } from '../../islands/shop/Gallery.tsx';
import {
  advanceFailedMedia,
  catalogMediaSourceId,
  createCatalogMediaState,
} from './catalog-media.ts';

test('normalizes blank, duplicate, and over-limit media into nine ordered sources', () => {
  const input = [
    ' one ',
    '',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
  ];
  const state = createCatalogMediaState(input);
  assert.deepEqual(state, {
    sources: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
    activeIndex: 0,
    failedSourceIds: [],
  });
  assert.deepEqual(input.slice(0, 3), [' one ', '', 'one']);
});

test('deduplicates mapped aliases before applying the nine-source bound', () => {
  const state = createCatalogMediaState(
    [' api/one ', '/api/one', ...Array.from({ length: 9 }, (_, index) => `unique-${index + 1}`)],
    (source) => (source.startsWith('api/') ? `/${source}` : source),
  );
  assert.deepEqual(state.sources, [
    '/api/one',
    'unique-1',
    'unique-2',
    'unique-3',
    'unique-4',
    'unique-5',
    'unique-6',
    'unique-7',
    'unique-8',
  ]);
});

test('Gallery consumer delegates effective alias dedupe before bounding', () => {
  const images = boundedGalleryImages([
    ' api/one ',
    '/api/one',
    ...Array.from({ length: 9 }, (_, index) => `unique-${index + 1}`),
  ]);
  assert.deepEqual(images, [
    '/api/one',
    'unique-1',
    'unique-2',
    'unique-3',
    'unique-4',
    'unique-5',
    'unique-6',
    'unique-7',
    'unique-8',
  ]);
});

test('only the current source identity advances once and exhaustion is terminal', () => {
  let state = createCatalogMediaState(['one', 'two']);
  const firstId = catalogMediaSourceId(0, 'one');
  assert.strictEqual(advanceFailedMedia(state, '1:two'), state);
  state = advanceFailedMedia(state, firstId);
  assert.equal(state.activeIndex, 1);
  assert.deepEqual(state.failedSourceIds, [firstId]);
  assert.strictEqual(advanceFailedMedia(state, firstId), state);
  const secondId = catalogMediaSourceId(1, 'two');
  state = advanceFailedMedia(state, secondId);
  assert.equal(state.activeIndex, 2);
  assert.deepEqual(state.failedSourceIds, [firstId, secondId]);
  assert.strictEqual(advanceFailedMedia(state, secondId), state);
});

test('state owns independent source and failure arrays', () => {
  const input = ['one', 'two'];
  const state = createCatalogMediaState(input);
  assert.notStrictEqual(state.sources, input);
  const advanced = advanceFailedMedia(state, catalogMediaSourceId(0, 'one'));
  assert.notStrictEqual(advanced.failedSourceIds, state.failedSourceIds);
});

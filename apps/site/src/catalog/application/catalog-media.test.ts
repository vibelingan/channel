import assert from 'node:assert/strict';
import test from 'node:test';
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

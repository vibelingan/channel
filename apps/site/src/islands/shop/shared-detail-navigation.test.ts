import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sharedDetailSearch,
  sharedListSearch,
  sharedListTarget,
  sharedVariantSearch,
} from './shared-detail-navigation.ts';

test('explicit development list can open a categoryless, slugless canonical ID', () => {
  assert.deepEqual(sharedListTarget(true, '?preview=shared'), { status: 'list' });
  assert.equal(
    sharedDetailSearch('?preview=shared&q=wire&page=2', 'product / 1'),
    '?preview=shared&q=wire&page=2&id=product+%2F+1',
  );
  assert.deepEqual(sharedListTarget(true, '?preview=shared&id=product+%2F+1'), {
    status: 'preview',
    productId: 'product / 1',
  });
});

test('return removes only detail identity, retaining list query and filter URL state', () => {
  assert.equal(
    sharedListSearch('?preview=shared&q=wire&category=wired&page=2&id=p1&variant=v1'),
    '?preview=shared&q=wire&category=wired&page=2',
  );
  assert.equal(
    sharedDetailSearch('?preview=shared&id=p1&variant=v1', 'p2'),
    '?preview=shared&id=p2',
  );
});

test('configuration URL writes a canonical ID and can clear an invalid selection', () => {
  assert.equal(
    sharedVariantSearch('?preview=shared&id=p1', 'sku + 2'),
    '?preview=shared&id=p1&variant=sku+%2B+2',
  );
  assert.equal(
    sharedVariantSearch('?preview=shared&id=p1&variant=missing'),
    '?preview=shared&id=p1',
  );
  assert.equal(sharedVariantSearch('?slug=legacy', 'v1'), undefined);
  assert.equal(sharedVariantSearch('?preview=shared&id=p1', ''), undefined);
});

test('production and ordinary legacy URLs never opt into preview navigation', () => {
  assert.deepEqual(sharedListTarget(false, '?preview=shared&id=p1'), { status: 'legacy' });
  assert.deepEqual(sharedListTarget(true, '?slug=legacy'), { status: 'legacy' });
  assert.equal(sharedDetailSearch('?slug=legacy', 'p1'), undefined);
});

test('ambiguous, traversal, and control-character identities fail closed', () => {
  for (const search of [
    '?preview=shared&preview=shared',
    '?preview=shared&variant=v1',
    '?preview=shared&id=',
    '?preview=shared&id=p1&id=p2',
    '?preview=shared&id=p1&slug=legacy',
    '?preview=wrong',
    '?preview=shared&id=..',
    '?preview=shared&id=%00',
  ])
    assert.deepEqual(sharedListTarget(true, search), { status: 'invalid' }, search);
  for (const id of ['', ' ', '..', '.', '\u0000', '\uD800', 'x'.repeat(201)]) {
    assert.equal(sharedDetailSearch('?preview=shared', id), undefined);
  }
});
